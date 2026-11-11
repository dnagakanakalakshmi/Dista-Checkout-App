const themes = {
  default: ["#5624d0", "#ff6b6b"],
  diwali: ["#8d2400", "#f5a000"],
  sale: ["#0d6b42", "#18b574"],
};

/** Self-contained proxy page: dynamic values are assigned via textContent in the browser. */
export function scratchPage({ token, state, theme = "default" }) {
  const [primary, accent] = themes[theme] || themes.default;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your surprise</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:system-ui,sans-serif;color:#fff;background:linear-gradient(135deg,${primary},${accent});display:grid;place-items:center;padding:20px}.card{width:min(100%,440px);text-align:center;background:#ffffff16;border:1px solid #ffffff44;border-radius:24px;padding:26px;box-shadow:0 16px 50px #0004}canvas{width:100%;height:240px;border-radius:15px;touch-action:none;display:block;margin:16px 0;background:#fff}button,a{border:0;border-radius:10px;background:#fff;color:${primary};font-weight:700;padding:13px 18px;margin:6px;text-decoration:none;font-size:16px;display:inline-block}#result{font-size:18px;line-height:1.5;white-space:pre-line}
</style></head><body><main class="card"><h1>You've unlocked a surprise! 🎉</h1><p id="hint">Scratch to reveal</p><canvas id="scratch" width="800" height="480"></canvas><div id="result"></div><div id="actions"></div></main><script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script><script>
const token=${JSON.stringify(token)}, initial=${JSON.stringify(state)};
const canvas=document.getElementById('scratch'),ctx=canvas.getContext('2d'),hint=document.getElementById('hint'),result=document.getElementById('result'),actions=document.getElementById('actions');
let drawing=false,checked=false;
function show(s){
  canvas.style.display=s.state==='issued'?'block':'none';
  hint.textContent=s.state==='issued'?'Scratch to Reveal 🎉':'';
  actions.replaceChildren();
  if(s.state==='issued'){
    result.textContent='Swipe or tap the card to uncover your reward.';
    const tap=document.createElement('button');
    tap.textContent='Tap to reveal';
    tap.onclick=()=>{if(!checked){checked=true;reveal();}};
    actions.append(tap);
    return;
  }
  if(s.state==='processing'){result.textContent='Your reward is being prepared…';setTimeout(reveal,1200);return;}
  if(s.state==='revealed'){
    result.textContent=s.label+(s.code?'\\nCode: '+s.code:'')+(s.expiresAt?'\\nExpires: '+new Date(s.expiresAt).toLocaleString():'');
    if(s.code){const a=document.createElement('a');a.href='/discount/'+encodeURIComponent(s.code)+'?redirect=/cart';a.textContent='Apply Now';actions.append(a);}
    const shop=document.createElement('a');shop.href='/';shop.textContent='Shop Now';actions.append(shop);
    if(window.confetti)confetti({particleCount:120,spread:70});
    return;
  }
  result.textContent=({void:'This card has been voided.',expired:'This reward has expired.',invalid:'This card is invalid.',error:'Network error. Please retry.'}[s.state]||'Unable to load card.');
  const retry=document.createElement('button');retry.textContent='Retry';retry.onclick=reveal;actions.append(retry);
}
function cover(){
  ctx.globalCompositeOperation='source-over';
  ctx.fillStyle='#cfcfcf';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#333';
  ctx.font='bold 38px system-ui';
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  ctx.fillText('Scratch to Reveal 🎉',400,240);
}
function point(e){
  const r=canvas.getBoundingClientRect(),p=e.touches?e.touches[0]:e;
  return{x:(p.clientX-r.left)*canvas.width/r.width,y:(p.clientY-r.top)*canvas.height/r.height};
}
function draw(e){
  if(!drawing)return;
  const p=point(e);
  ctx.globalCompositeOperation='destination-out';
  ctx.beginPath();ctx.arc(p.x,p.y,48,0,Math.PI*2);ctx.fill();
  if(!checked&&cleared()>0.42){checked=true;reveal();}
}
function cleared(){
  const d=ctx.getImageData(0,0,canvas.width,canvas.height).data;let n=0;
  for(let i=3;i<d.length;i+=120)n+=d[i]<10;
  return n/(d.length/120);
}
async function reveal(){
  hint.textContent='Revealing…';
  try{
    const r=await fetch('/apps/scratch/reveal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),credentials:'same-origin'});
    show(await r.json());
  }catch{show({state:'error'});}
}
canvas.onpointerdown=e=>{drawing=true;canvas.setPointerCapture(e.pointerId);draw(e)};
canvas.onpointermove=draw;
canvas.onpointerup=()=>drawing=false;
cover();
show(initial);
</script></body></html>`;
}
