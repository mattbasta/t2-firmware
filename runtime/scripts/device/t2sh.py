#!/usr/bin/env python3
"""Short commands over the Tessel 2 USB serial console (stdlib only). Always drains; never leaves the board mid-output.
usage: t2sh.py [-t secs] 'cmd' ['cmd' ...]"""
import os, re, sys, termios, time, select, argparse
ap = argparse.ArgumentParser(); ap.add_argument('-t', type=float, default=15.0); ap.add_argument('-d', default='/dev/cu.usbmodem2102'); ap.add_argument('--send'); ap.add_argument('cmds', nargs='+')
a = ap.parse_args()
fd = os.open(a.d, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
at = termios.tcgetattr(fd); at[0]=0; at[1]=0; at[2]=termios.CS8|termios.CREAD|termios.CLOCAL; at[3]=0; at[4]=at[5]=termios.B115200
termios.tcsetattr(fd, termios.TCSANOW, at)
def drain(secs):
    out=b''; end=time.time()+secs
    while True:
        r,_,_=select.select([fd],[],[],0)
        if not r: break
        try: out+=os.read(fd,65536)
        except BlockingIOError: break
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.05)
        if r:
            try: out+=os.read(fd,65536)
            except BlockingIOError: pass
    return out
def write_all(data):
    v=memoryview(data); sent=0
    while sent<len(v):
        _,w,_=select.select([],[fd],[],1.0)
        if not w: continue
        try: n=os.write(fd, v[sent:sent+512])
        except BlockingIOError: n=0
        sent+=n; drain(0)
write_all(b'\x03'); drain(0.5); write_all(b'\n'); drain(0.5)
if a.send:
    data=open(a.send,'rb').read()
    write_all((a.cmds[0]+'\n').encode())
    buf=b''; deadline=time.time()+40
    while b'READY' not in buf and time.time()<deadline: buf+=drain(0.5)
    if b'READY' not in buf: sys.exit('receiver never said READY: '+buf.decode('utf-8','replace')[-500:])
    print('receiver ready, streaming', len(data), 'bytes', flush=True)
    t0=time.time(); write_all(data if data.endswith(b'\n') else data+b'\n'); write_all(b'EOF\n')
    print(f'sent in {time.time()-t0:.0f}s ({len(data)/(time.time()-t0)/1024:.1f} KB/s)', flush=True)
    buf=b''; deadline=time.time()+60
    while b'RECEIVED' not in buf and time.time()<deadline: buf+=drain(0.5)
    print(buf.decode('utf-8','replace').strip()[-300:], flush=True)
    drain(1.0); sys.exit(0)
for i,c in enumerate(a.cmds):
    S,E=f'__T2_{i}_S',f'__T2_{i}_E'
    write_all((f'echo __T2_{i}_"S"; {c}; echo __T2_{i}_"E"\n').encode())
    buf=b''; deadline=time.time()+a.t; pat=re.compile(rf'^{S}\r?\n(.*?)^{E}\r?$', re.S|re.M); body=None
    while time.time()<deadline:
        buf+=drain(0.2); m=pat.search(buf.decode('utf-8','replace'))
        if m: body=m.group(1).strip(); break
    print(f'$ {c}\n{body if body is not None else "(timeout) "+buf.decode("utf-8","replace")[-600:]}\n', flush=True)
drain(2.0)
