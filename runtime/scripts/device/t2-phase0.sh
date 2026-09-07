#!/bin/sh
# Phase 0 on-device measurements for the Tessel 2 runtime. Run as: sh /root/t2-phase0.sh
T=/root/tjs
now() { cut -d" " -f1 /proc/uptime; }
elapsed() { awk "BEGIN{print $2-$1}"; }
echo "== identity"; uname -a; grep -E "cpu model|system type" /proc/cpuinfo; ls -la $T; md5sum $T
echo "== smoke"; $T eval 'console.log("tjs", tjs.version, "on real hardware")'
echo "== numerics probe (want the exact x86 reference list)"
$T eval 'console.log(JSON.stringify([0.1+0.2, Math.PI*1e10, 2**53+1, (0/0)!==(0/0), Number.isNaN(NaN), Object.is(-0,0), 1e308*10, parseFloat("3.14e-5"), (123456789.123456789).toFixed(6), [1.5,2.5,-0.5].map(Math.round), NaN.toString(), String(9007199254740993n+1n), (0.1).toString(2).length, Math.fround(1.1), new Float64Array([NaN])[0], Number.MAX_SAFE_INTEGER, (-1)**0.5, Math.hypot(3,4), Date.UTC(2026,8,2)]))'
echo 'reference: [0.30000000000000004,31415926535.89793,9007199254740992,true,true,false,null,0.0000314,"123456789.123457",[2,3,0],"NaN","9007199254740994",57,1.100000023841858,null,9007199254740991,null,5,1788307200000]'
echo "== NaN encoding on this core (pre-NaN2008?)"
$T eval 'const b=new Float64Array([NaN]); const u=new Uint8Array(b.buffer); console.log("NaN bytes:", Array.from(u).map(x=>x.toString(16).padStart(2,"0")).join(" "), "| 0/0 isNaN:", Number.isNaN(0/0), "| NaN===NaN:", NaN===NaN, "| typeof NaN box roundtrip:", typeof [NaN][0])'
echo "== startup (x3)"
for i in 1 2 3; do t0=$(now); $T eval 1; t1=$(now); printf "tjs startup: %s s\n" "$(elapsed $t0 $t1)"; done
echo "== RSS (idle, 3s)"
$T eval 'setTimeout(()=>{}, 4000)' & P=$!; sleep 2; grep -E "VmRSS|VmHWM" /proc/$P/status; wait $P
echo "== float loop (Node 4: 33.8 s)"
t0=$(now); $T eval 'var s=0;for(var i=0;i<3000000;i++){s+=i*1.5}console.log(s)'; t1=$(now); printf "float loop: %s s\n" "$(elapsed $t0 $t1)"
echo "== int loop (Node 4: 19.56 s)"
t0=$(now); $T eval 'var s=0;for(var i=0;i<3000000;i++){s+=i}console.log(s)'; t1=$(now); printf "int loop: %s s\n" "$(elapsed $t0 $t1)"
echo "== spid handshake (port A, pin 5)"
$T run /root/spid-test.js
echo "== done"
