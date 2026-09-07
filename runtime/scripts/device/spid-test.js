// spid handshake from the new runtime, speaking exactly the wire protocol tessel-export.js speaks:
//   ECHO len payload      -> DATA(0x84) + payload            (Port.sync)
//   GPIO_HIGH/LOW pin     -> no reply; followed by an ECHO sync (Port.command)
//   GPIO_IN pin           -> single byte HIGH(0x82)/LOW(0x83) (Port.status)
const CMD = { ECHO: 2, GPIO_IN: 3, GPIO_HIGH: 4, GPIO_LOW: 5 };
const REPLY = { DATA: 0x84, HIGH: 0x82, LOW: 0x83 };
const PIN = 5;
(async () => {
    const sock = new PipeSocket('/var/run/tessel/port_a');
    const { readable, writable } = await sock.opened;
    const w = writable.getWriter();
    const r = readable.getReader();
    let pending = new Uint8Array(0);
    async function exchange(bytes, expectLen) {
        await w.write(new Uint8Array(bytes));
        while (pending.length < expectLen) {
            const { value, done } = await r.read();
            if (done) throw new Error('spid closed the socket');
            const next = new Uint8Array(pending.length + value.length);
            next.set(pending); next.set(value, pending.length); pending = next;
        }
        const out = Array.from(pending.subarray(0, expectLen));
        pending = pending.subarray(expectLen);
        return out;
    }
    let fails = 0;
    const check = (name, got, want) => { const ok = got.join(',') === want.join(','); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got [${got}] want [${want}]`); };
    const sync = () => exchange([CMD.ECHO, 1, 0x88], 2);
    check('echo 0x88 -> DATA+payload', await sync(), [REPLY.DATA, 0x88]);
    await w.write(new Uint8Array([CMD.GPIO_HIGH, PIN]));
    check(`gpio_high pin ${PIN} (+sync)`, await sync(), [REPLY.DATA, 0x88]);
    check('gpio_in reads HIGH', await exchange([CMD.GPIO_IN, PIN], 1), [REPLY.HIGH]);
    await w.write(new Uint8Array([CMD.GPIO_LOW, PIN]));
    check(`gpio_low pin ${PIN} (+sync)`, await sync(), [REPLY.DATA, 0x88]);
    check('gpio_in reads LOW', await exchange([CMD.GPIO_IN, PIN], 1), [REPLY.LOW]);
    sock.close();
    console.log(fails ? `SPID_FAIL ${fails}` : 'SPID_DONE all ok');
})().catch(e => { console.log('FAIL', e.message); });
