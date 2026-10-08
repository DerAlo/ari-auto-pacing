# pty driver for the Claude Code TUI, used by run-interactive.js.
#
#   python3 -I pty-driver.py <spec.json> <out-prefix>
#
# spec.json: {"argv": [...], "env": {...}, "cwd": "...", "rows": N, "cols": N}. The file is
# deleted right after it is read (it holds the fake credential of the run).
#
# The child runs in a pseudo terminal. Its output goes through a small VT100/xterm screen
# emulator, because the TUI redraws only the cells that change: stripping ANSI codes from
# the raw stream leaves broken words, while the emulated screen holds the real text.
#
# Claude Code 2.1.291 draws in the alternate screen (fullscreen), so nothing reaches the
# scrollback. The emulator therefore keeps a history: every distinct line that was on the
# screen at a snapshot (each screen request, before every clear and alternate-screen
# switch), in first-seen order. "all" is that history; the capture file holds the last
# alternate screen (the whole session as it looked before /exit) and what followed it.
#
# Control protocol: JSON lines on stdin, answers as JSON lines on stdout.
#   {"op":"send","text":"..."}         -> {"op":"sent","t":...}
#   {"op":"screen","id":N}             -> {"op":"screen","id":N,"screen":"...","all":"...","alive":bool}
#   {"op":"quit","grace":SEC}          -> waits up to SEC for the child to exit, then kills it
# When the child exits on its own: {"op":"exit","status":N}.
# At the end <out-prefix>.raw (bytes), <out-prefix>.txt (scrollback + screen) are written.
import codecs, fcntl, json, os, pty, select, signal, struct, sys, termios, time, unicodedata

spec_file, out = sys.argv[1], sys.argv[2]
with open(spec_file) as f:
    spec = json.load(f)
os.unlink(spec_file)
ROWS, COLS = int(spec.get('rows', 45)), int(spec.get('cols', 150))


def char_width(ch):
    o = ord(ch)
    if o < 32 or o == 0x200d or 0xfe00 <= o <= 0xfe0f:
        return 0
    if unicodedata.combining(ch) or unicodedata.category(ch) in ('Mn', 'Me', 'Cf'):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1


class Screen:
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.grid = [self.blank() for _ in range(rows)]
        self.scrollback = []
        self.x = self.y = 0
        self.top, self.bot = 0, rows - 1
        self.saved = (0, 0)
        self.wrap = False
        self.alt = None
        self.last_alt = None
        self.history = []
        self.seen = set()
        self.state = 'ground'
        self.buf = ''
        self.dec = codecs.getincrementaldecoder('utf-8')('replace')

    def blank(self):
        return [' '] * self.cols

    # --- movement and scrolling ---
    def scroll_up(self, n=1):
        for _ in range(n):
            line = self.grid.pop(self.top)
            if self.top == 0 and self.alt is None:
                self.scrollback.append(line)
            self.grid.insert(self.bot, self.blank())

    def scroll_down(self, n=1):
        for _ in range(n):
            self.grid.pop(self.bot)
            self.grid.insert(self.top, self.blank())

    def linefeed(self):
        if self.y == self.bot:
            self.scroll_up()
        elif self.y < self.rows - 1:
            self.y += 1

    def goto(self, y, x):
        self.y = max(0, min(self.rows - 1, y))
        self.x = max(0, min(self.cols - 1, x))
        self.wrap = False

    def put(self, ch):
        w = char_width(ch)
        if w == 0:
            return
        if self.wrap:
            self.x = 0
            self.linefeed()
            self.wrap = False
        if self.x + w > self.cols:
            self.x = 0
            self.linefeed()
        self.grid[self.y][self.x] = ch
        if w == 2 and self.x + 1 < self.cols:
            self.grid[self.y][self.x + 1] = ''
        self.x += w
        if self.x >= self.cols:
            self.x = self.cols - 1
            self.wrap = True

    def erase(self, y, x0, x1):
        row = self.grid[y]
        for i in range(max(0, x0), min(self.cols, x1)):
            row[i] = ' '

    # --- escape sequences ---
    def csi(self, seq):
        final = seq[-1]
        body = seq[:-1]
        priv = ''
        if body and body[0] in '?<>=':
            priv, body = body[0], body[1:]
        while body and not (body[-1].isdigit() or body[-1] in ';:'):
            body = body[:-1]  # intermediates such as ' ' or '$'
        params = []
        for p in body.split(';') if body else []:
            p = p.split(':')[0]
            params.append(int(p) if p.isdigit() else 0)
        p0 = params[0] if params else 0
        n = p0 or 1
        if priv and final not in 'hl':
            return  # queries and keyboard-protocol settings: nothing to draw
        if final == 'A':
            self.goto(self.y - n, self.x)
        elif final == 'B':
            self.goto(self.y + n, self.x)
        elif final == 'C':
            self.goto(self.y, self.x + n)
        elif final == 'D':
            self.goto(self.y, self.x - n)
        elif final == 'E':
            self.goto(self.y + n, 0)
        elif final == 'F':
            self.goto(self.y - n, 0)
        elif final in 'G`':
            self.goto(self.y, n - 1)
        elif final == 'd':
            self.goto(n - 1, self.x)
        elif final in 'Hf':
            self.goto((params[0] or 1) - 1 if params else 0, (params[1] or 1) - 1 if len(params) > 1 else 0)
        elif final == 'J':
            if p0 == 0:
                self.erase(self.y, self.x, self.cols)
                for r in range(self.y + 1, self.rows):
                    self.grid[r] = self.blank()
            elif p0 == 1:
                self.erase(self.y, 0, self.x + 1)
                for r in range(0, self.y):
                    self.grid[r] = self.blank()
            else:
                self.snapshot()
                self.grid = [self.blank() for _ in range(self.rows)]
        elif final == 'K':
            if p0 == 0:
                self.erase(self.y, self.x, self.cols)
            elif p0 == 1:
                self.erase(self.y, 0, self.x + 1)
            else:
                self.erase(self.y, 0, self.cols)
            self.wrap = False
        elif final == 'X':
            self.erase(self.y, self.x, self.x + n)
        elif final == '@':
            row = self.grid[self.y]
            self.grid[self.y] = (row[:self.x] + [' '] * n + row[self.x:])[:self.cols]
        elif final == 'P':
            row = self.grid[self.y]
            self.grid[self.y] = row[:self.x] + row[self.x + n:] + [' '] * n
        elif final == 'L':
            if self.top <= self.y <= self.bot:
                for _ in range(n):
                    self.grid.pop(self.bot)
                    self.grid.insert(self.y, self.blank())
        elif final == 'M':
            if self.top <= self.y <= self.bot:
                for _ in range(n):
                    self.grid.pop(self.y)
                    self.grid.insert(self.bot, self.blank())
        elif final == 'S':
            self.scroll_up(n)
        elif final == 'T':
            self.scroll_down(n)
        elif final == 'r':
            t = (params[0] or 1) - 1 if params else 0
            b = (params[1] or self.rows) - 1 if len(params) > 1 else self.rows - 1
            if 0 <= t < b < self.rows:
                self.top, self.bot = t, b
            self.goto(0, 0)
        elif final == 's':
            self.saved = (self.y, self.x)
        elif final == 'u':
            self.goto(*self.saved)
        elif final in 'hl' and priv == '?':
            for p in params:
                if p in (47, 1047, 1049):
                    self.snapshot()
                    if final == 'h' and self.alt is None:
                        self.alt = (self.grid, self.y, self.x)
                        self.grid = [self.blank() for _ in range(self.rows)]
                    elif final == 'l' and self.alt is not None:
                        self.last_alt = self.screen_text()
                        self.grid, self.y, self.x = self.alt
                        self.alt = None

    def esc(self, ch):
        if ch == '7':
            self.saved = (self.y, self.x)
        elif ch == '8':
            self.goto(*self.saved)
        elif ch == 'D':
            self.linefeed()
        elif ch == 'E':
            self.x = 0
            self.linefeed()
        elif ch == 'M':
            if self.y == self.top:
                self.scroll_down()
            elif self.y > 0:
                self.y -= 1
        elif ch == 'c':
            self.snapshot()
            self.grid = [self.blank() for _ in range(self.rows)]
            self.goto(0, 0)

    def feed(self, data):
        for ch in self.dec.decode(data):
            st = self.state
            if st == 'ground':
                if ch == '\x1b':
                    self.state = 'esc'
                elif ch == '\r':
                    self.x = 0
                    self.wrap = False
                elif ch in '\n\x0b\x0c':
                    self.linefeed()
                    self.wrap = False
                elif ch == '\b':
                    self.goto(self.y, self.x - 1)
                elif ch == '\t':
                    self.goto(self.y, (self.x // 8 + 1) * 8)
                elif ord(ch) >= 32 and ch != '\x7f':
                    self.put(ch)
            elif st == 'esc':
                if ch == '[':
                    self.state, self.buf = 'csi', ''
                elif ch == ']':
                    self.state, self.buf = 'osc', ''
                elif ch in 'PX^_':
                    self.state = 'str'
                elif ch in '()*+#%':
                    self.state = 'charset'
                else:
                    self.state = 'ground'
                    self.esc(ch)
            elif st == 'charset':
                self.state = 'ground'
            elif st == 'csi':
                if '@' <= ch <= '~':
                    self.state = 'ground'
                    self.csi(self.buf + ch)
                elif len(self.buf) < 64:
                    self.buf += ch
                else:
                    self.state = 'ground'
            elif st in ('osc', 'str'):
                if ch == '\x07':
                    self.state = 'ground'
                elif ch == '\x1b':
                    self.state = st + '-esc'
            elif st in ('osc-esc', 'str-esc'):
                self.state = 'ground' if ch == '\\' else st[:-4]

    @staticmethod
    def lines_text(lines):
        return '\n'.join(''.join(l).rstrip() for l in lines)

    def screen_text(self):
        return self.lines_text(self.grid)

    def snapshot(self):
        for line in self.scrollback + self.grid:
            t = ''.join(line).rstrip()
            if t.strip() and t not in self.seen:
                self.seen.add(t)
                self.history.append(t)
        self.scrollback = []

    def all_text(self):
        self.snapshot()
        return '\n'.join(self.history)

    def capture(self):
        if self.alt is not None:
            return self.screen_text().rstrip() + '\n'
        if self.last_alt is not None:
            after = self.lines_text(self.scrollback + self.grid).strip('\n')
            return self.last_alt.rstrip() + '\n\n[alternate screen closed]\n' + after + '\n'
        return self.all_text() + '\n'


def reply(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec['cwd'])
    os.execve(spec['argv'][0], spec['argv'], spec['env'])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
scr = Screen(ROWS, COLS)
raw = bytearray()
alive = True
status = None
inbuf = b''
quit_at = None
t0 = time.time()


def reap(block=False):
    global alive, status
    if not alive:
        return
    try:
        p, st = os.waitpid(pid, 0 if block else os.WNOHANG)
    except ChildProcessError:
        p, st = pid, 0
    if p == pid:
        alive = False
        status = os.waitstatus_to_exitcode(st) if hasattr(os, 'waitstatus_to_exitcode') else st
        reply({'op': 'exit', 'status': status, 't': round(time.time() - t0, 3)})


stdin_fd = sys.stdin.fileno()
stdin_open = True
while True:
    fds = [fd] if alive or fd is not None else []
    if stdin_open:
        fds.append(stdin_fd)
    try:
        r, _, _ = select.select([x for x in fds if x is not None], [], [], 0.05)
    except (OSError, ValueError):
        r = []
    if fd is not None and fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if data:
            raw += data
            scr.feed(data)
        else:
            os.close(fd)
            fd = None
            reap(block=True)
    if stdin_fd in r:
        chunk = os.read(stdin_fd, 65536)
        if not chunk:
            stdin_open = False
            if quit_at is None:
                quit_at = time.time()
        inbuf += chunk
        while b'\n' in inbuf:
            line, inbuf = inbuf.split(b'\n', 1)
            if not line.strip():
                continue
            cmd = json.loads(line)
            op = cmd.get('op')
            if op == 'send':
                if fd is not None:
                    os.write(fd, cmd['text'].encode())
                reply({'op': 'sent', 't': round(time.time() - t0, 3)})
            elif op == 'screen':
                screen = scr.screen_text()
                reply({'op': 'screen', 'id': cmd.get('id'), 'screen': screen, 'all': scr.all_text(), 'alive': alive})
            elif op == 'quit':
                quit_at = time.time() + float(cmd.get('grace', 0))
    reap()
    if quit_at is not None and time.time() >= quit_at:
        break
    if not alive and fd is None and not stdin_open:
        break

if alive:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except OSError:
            pass
        end = time.time() + 1.5
        while alive and time.time() < end:
            if fd is not None:
                r, _, _ = select.select([fd], [], [], 0.05)
                if r:
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        data = b''
                    if data:
                        raw += data
                        scr.feed(data)
            else:
                time.sleep(0.05)
            reap()
        if not alive:
            break
with open(out + '.raw', 'wb') as f:
    f.write(bytes(raw))
with open(out + '.txt', 'w') as f:
    f.write(scr.capture())
with open(out + '.history.txt', 'w') as f:
    f.write(scr.all_text() + '\n')
reply({'op': 'done', 'status': status})
