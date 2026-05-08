require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const lineConfig = { channelSecret: process.env.LINE_CHANNEL_SECRET, channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN };
const lineClient = new line.messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const app = express();
const sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = { payments: [] };
    return sessions[id];
    }

    async function analyzeMessage(text, userName) {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `你是聚餐分帳助手，從訊息判斷意圖，只輸出JSON（無markdown）：{"action":"add"|"summary"|"clear"|"list"|"help"|"none","payment":{"payer":"姓名","amount":數字,"description":"品項"}|null,"reply":"繁體中文回覆"}
        用戶：${userName}\n訊息：${text}`;
          const result = await model.generateContent(prompt);
            const raw = result.response.text().trim().replace(/```json|```/g,"").trim();
              try { return JSON.parse(raw); } catch { return { action:"none", payment:null, reply:raw }; }
              }

              function calculateSummary(payments) {
                if (!payments.length) return null;
                  const totals = {};
                    payments.forEach(p => { totals[p.payer] = (totals[p.payer]||0) + p.amount; });
                      const names = Object.keys(totals);
                        const grand = Object.values(totals).reduce((a,b)=>a+b,0);
                          const perPerson = Math.round(grand/names.length);
                            const balances = names.map(n=>({name:n,balance:totals[n]-perPerson}));
                              const settlements = [];
                                const creds = balances.filter(b=>b.balance>0).sort((a,b)=>b.balance-a.balance).map(b=>({...b}));
                                  const debts = balances.filter(b=>b.balance<0).sort((a,b)=>a.balance-b.balance).map(b=>({...b}));
                                    let ci=0,di=0;
                                      while(ci<creds.length&&di<debts.length){
                                          const amt=Math.min(creds[ci].balance,-debts[di].balance);
                                              if(amt>0) settlements.push({from:debts[di].name,to:creds[ci].name,amount:amt});
                                                  creds[ci].balance-=amt; debts[di].balance+=amt;
                                                      if(creds[ci].balance===0)ci++; if(debts[di].balance===0)di++;
                                                        }
                                                          return {totals,grand,perPerson,settlements,count:names.length};
                                                          }

                                                          app.post("/webhook", line.middleware(lineConfig), async (req,res) => {
                                                            res.sendStatus(200);
                                                              for (const event of (req.body.events||[])) {
                                                                  if (event.type!=="message"||event.message.type!=="text") continue;
                                                                      const text = event.message.text.trim();
                                                                          const sourceId = event.source.groupId||event.source.roomId||event.source.userId;
                                                                              const userId = event.source.userId;
                                                                                  let userName = "用戶";
                                                                                      try {
                                                                                            userName = event.source.groupId
                                                                                                    ? (await lineClient.getGroupMemberProfile(event.source.groupId,userId)).displayName
                                                                                                            : (await lineClient.getProfile(userId)).displayName;
                                                                                                                } catch {}
                                                                                                                    const session = getSession(sourceId);
                                                                                                                        try {
                                                                                                                              const r = await analyzeMessage(text,userName);
                                                                                                                                    let reply = r.reply||"";
                                                                                                                                          if (r.action==="add"&&r.payment?.amount) {
                                                                                                                                                  const payer = r.payment.payer==="我"?userName:r.payment.payer;
                                                                                                                                                          session.payments.push({payer,amount:r.payment.amount,description:r.payment.description||""});
                                                                                                                                                                  reply = reply.replace(/^我/,userName);
                                                                                                                                                                        } else if (r.action==="summary") {
                                                                                                                                                                                const s = calculateSummary(session.payments);
                                                                                                                                                                                        if (!s) { reply="目前還沒有任何帳目 😅"; }
                                                                                                                                                                                                else {
                                                                                                                                                                                                          reply = `📊 帳目（共${s.grand}元，${s.count}人）\n`;
                                                                                                                                                                                                                    Object.entries(s.totals).forEach(([n,a])=>{reply+=`👤${n}：$${a}\n`;});
                                                                                                                                                                                                                              reply+=`每人應付：$${s.perPerson}\n`;
                                                                                                                                                                                                                                        if(!s.settlements.length){reply+="✅ 大家都平了！";}
                                                                                                                                                                                                                                                  else{reply+="💸 需轉帳：\n";s.settlements.forEach(t=>{reply+=`${t.from}→${t.to} $${t.amount}\n`;});}
                                                                                                                                                                                                                                                          }
                                                                                                                                                                                                                                                                } else if (r.action==="clear") { session.payments=[]; reply="🗑️ 已清空！"; }
                                                                                                                                                                                                                                                                      else if (r.action==="list") {
                                                                                                                                                                                                                                                                              if(!session.payments.length){reply="📋 無紀錄";}
                                                                                                                                                                                                                                                                                      else{reply=`📋 共${session.payments.length}筆\n`;session.payments.forEach((p,i)=>{reply+=`${i+1}.${p.payer}付$${p.amount}${p.description?"("+p.description+")":""}\n`;});}
                                                                                                                                                                                                                                                                                            } else if (r.action==="help") {
                                                                                                                                                                                                                                                                                                    reply="🍽️ 分帳小幫手\n・我付了350 牛排\n・小明付了200 飲料\n・說「結算」算誰欠誰\n・說「清空」重新開始";
                                                                                                                                                                                                                                                                                                          }
                                                                                                                                                                                                                                                                                                                if (reply) await lineClient.replyMessage({replyToken:event.replyToken,messages:[{type:"text",text:reply}]});
                                                                                                                                                                                                                                                                                                                    } catch(err) {
                                                                                                                                                                                                                                                                                                                          console.error(err);
                                                                                                                                                                                                                                                                                                                                await lineClient.replyMessage({replyToken:event.replyToken,messages:[{type:"text",text:"😅 錯誤，請再試"}]}).catch(()=>{});
                                                                                                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                                                                      });
                                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                                      app.get("/",(req,res)=>res.send("Bot running! 🍽️"));
                                                                                                                                                                                                                                                                                                                                      app.listen(process.env.PORT||3000,()=>console.log("Server started"));
