# Device-side tooling

Scripts for putting the cross-built runtime on a Tessel 2 and measuring it. Used
for the Phase 0 spike (see [../../docs/phase0-results.md](../../docs/phase0-results.md)).

- `ssh_config` — client options the board's 2015-era dropbear needs
  (`ssh -F runtime/scripts/device/ssh_config t2`). Keys go in
  `/etc/dropbear/authorized_keys` on the board; `~/.ssh` is ignored.
- `t2sh.py` — run short commands over the USB serial console
  (`/dev/cu.usbmodem*`). Always drains the console so the board never blocks on
  output. Keep command lines short (< ~400 chars); do not use it to transfer
  files.
- `t2-phase0.sh` — the on-device measurement script: numerics probe, NaN byte
  pattern, startup, RSS, float/int loops, spid handshake. `scp` it with `tjs`
  and `spid-test.js` to `/root` and run `sh /root/t2-phase0.sh`.
- `spid-test.js` — exercises the spid Unix-socket protocol from the runtime
  (echo, GPIO high/low with readback on port A pin 5).
