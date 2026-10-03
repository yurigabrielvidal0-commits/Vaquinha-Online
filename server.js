const express=require("express");
const path=require("path");
const crypto=require("crypto");
const app=express();
const PORT=process.env.PORT||10000;
const API="https://pixghost.site/api.php";
const STATUS="https://pixghost.site/check_status.php";

app.post("/webhook/lunarpay",express.raw({type:"application/json"}),(req,res)=>{
  const key=process.env.LUNARPAY_API_KEY;if(!key)return res.sendStatus(500);
  const sig=req.get("X-LunarPay-Signature")||"", raw=Buffer.isBuffer(req.body)?req.body:Buffer.from("");
  const expected=crypto.createHmac("sha256",key).update(raw).digest("hex");
  const a=Buffer.from(sig),b=Buffer.from(expected);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.sendStatus(401);
  try{console.log("LunarPay webhook:",JSON.parse(raw.toString("utf8")));return res.sendStatus(200);}catch{return res.sendStatus(400);}
});
app.use(express.json({limit:"100kb"}));
app.use(express.static(path.join(__dirname)));

function publicUrl(req){return (process.env.PUBLIC_URL||`${req.protocol}://${req.get("host")}`).replace(/\/$/,"");}
app.post("/api/create-charge",async(req,res)=>{
  try{
    const amount=Number(req.body?.amount);
    if(!Number.isFinite(amount)||amount<5)return res.status(400).json({success:false,error:"O valor mínimo para a doação é R$ 5,00."});
    const external_id=`doacao_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
    const r=await fetch(API,{method:"POST",headers:{"Authorization":`Bearer ${process.env.LUNARPAY_API_KEY||""}`,"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({amount:Math.round(amount*100)/100,external_id,callback_url:`${publicUrl(req)}/webhook/lunarpay`})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.success)return res.status(r.status||502).json({success:false,error:d.error||d.message||"A LunarPay não conseguiu gerar o Pix."});
    res.json({success:true,external_id,pix_id:d.pix_id,amount:d.amount,pix_code:d.pix_code,qr_image:d.qr_image});
  }catch(e){console.error(e);res.status(500).json({success:false,error:"Erro interno ao gerar o Pix."});}
});
app.get("/api/status",async(req,res)=>{
  try{
    const id=String(req.query.external_id||"").trim();if(!id)return res.status(400).json({success:false,error:"external_id obrigatório."});
    const r=await fetch(`${STATUS}?external_id=${encodeURIComponent(id)}`,{headers:{"Authorization":`Bearer ${process.env.LUNARPAY_API_KEY||""}`,"Accept":"application/json"}});
    const d=await r.json().catch(()=>({}));res.status(r.ok?200:r.status||502).json(d);
  }catch(e){res.status(500).json({success:false,error:"Erro interno ao consultar o pagamento."});}
});
app.get("/health",(req,res)=>res.json({ok:true}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.listen(PORT,()=>console.log(`Vaquinha Online na porta ${PORT}`));
