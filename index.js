require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const Anthropic = require("@anthropic-ai/sdk");

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    };
    const lineClient = new line.messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      });
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const app = express();
      const sessions = {};

      function getSession(id) {
        if (!sessions[id]) sessions[id] = { payments: [] };
          return sessions[id];
          }

          const SYSTEM_PROMPT = `你是一個聚餐分帳助手 Line Bot。
          從用戶訊息中判斷意圖，回覆必須是 JSON（不要有 markdown code block）：
          {"action":"add"|"summary"|"clear"|"list"|"help"|"none","payment":{"payer":"姓名","amount":數字,"description":"品項"}|null,"reply":"回覆給用戶的繁體中文訊息（可用 emoji）"}
          規則：
          - add：偵測到付款紀錄
          - summary：「結算」「算帳」「誰欠誰」「分帳」「AA」
          - clear：「清空」「重來」「新的一餐」
          - list：「帳目」「紀錄」「目前」
          - help：「怎麼用」「說明」「help」「?」
          - 如果 payer 是「我」，保留為「我」
          - 只輸出 JSON`;

          async function analyzeMessage(text, userName) {
            const response = await anthropic.messages.create({
                model: "claude-sonnet-4-20250514",
                    max_tokens: 500,
                        system: SYSTEM_PROMPT,
                            messages: [{ role: "user", content: `用戶名稱：${userName}\n訊息：${text}` }],
                              });
                                const raw = response.content[0].text.trim();
                                  try { return JSON.parse(raw); }
                                    catch { return { action: "none", payment: null, reply: raw }; }
                                    }

                                    function calculateSummary(payments) {
                                      if (payments.length === 0) return null;
                                        const totals = {};
                                          payments.forEach(p => { totals[p.payer] = (totals[p.payer] || 0) + p.amount; });
                                            const names = Object.keys(totals);
                                              const grand = Object.values(totals).reduce((a, b) => a + b, 0);
                                                const perPerson = Math.round(grand / names.length);
                                                  const balances = names.map(n => ({ name: n, balance: totals[n] - perPerson }));
                                                    const settlements = [];
                                                      const creds = balances.filter(b => b.balance > 0).sort((a, b) => b.balance - a.balance).map(b => ({ ...b }));
                                                        const debts = balances.filter(b => b.balance < 0).sort((a, b) => a.balance - b.balance).map(b => ({ ...b }));
                                                          let ci = 0, di = 0;
                                                            while (ci < creds.length && di < debts.length) {
                                                                const amt = Math.min(creds[ci].balance, -debts[di].balance);
                                                                    if (amt > 0) settlements.push({ from: debts[di].name, to: creds[ci].name, amount: amt });
                                                                        creds[ci].balance -= amt; debts[di].balance += amt;
                                                                            if (creds[ci].balance === 0) ci++;
                                                                                if (debts[di].balance === 0) di++;
                                                                                  }
                                                                                    return { totals, grand, perPerson, settlements, count: names.length };
                                                                                    }

                                                                                    function buildSummaryText(session) {
                                                                                      const s = calculateSummary(session.payments);
                                                                                        if (!s) return "目前還沒有任何帳目 😅";
                                                                                          let msg = `📊 目前帳目（共 ${s.grand} 元，${s.count} 人）\n─────────────────\n`;
                                                                                            Object.entries(s.totals).forEach(([name, amt]) => { msg += `👤 ${name}：$${amt}\n`; });
                                                                                              msg += `─────────────────\n每人應付：$${s.perPerson}\n`;
                                                                                                if (s.settlements.length === 0) { msg += "\n✅ 大家都平了！"; }
                                                                                                  else { msg += "\n💸 需要轉帳：\n"; s.settlements.forEach(t => { msg += `${t.from} → ${t.to}  $${t.amount}\n`; }); }
                                                                                                    return msg.trim();
                                                                                                    }
                                                                                                    
                                                                                                    function buildListText(session) {
                                                                                                      if (session.payments.length === 0) return "📋 目前沒有任何紀錄";
                                                                                                        let msg = `📋 帳目紀錄（共 ${session.payments.length} 筆）\n─────────────────\n`;
                                                                                                          session.payments.forEach((p, i) => { msg += `${i + 1}. ${p.payer} 付了 $${p.amount}${p.description ? "（" + p.description + "）" : ""}\n`; });
                                                                                                            return msg.trim();
                                                                                                            }
                                                                                                            
                                                                                                            const HELP_TEXT = `🍽️ 分帳小幫手使用說明\n\n📝 記錄付款：\n・「我付了350 牛排」\n・「小明付了200 飲料」\n\n📊 查看帳目：\n・「帳目」「目前紀錄」\n\n💰 結算分帳：\n・「結算」「算帳」「AA」\n\n🗑️ 清空重來：\n・「清空」「新的一餐」`;
                                                                                                            
                                                                                                            app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
                                                                                                              res.sendStatus(200);
                                                                                                                const events = req.body.events || [];
                                                                                                                  for (const event of events) {
                                                                                                                      if (event.type !== "message" || event.message.type !== "text") continue;
                                                                                                                          const text = event.message.text.trim();
                                                                                                                              const replyToken = event.replyToken;
                                                                                                                                  const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
                                                                                                                                      const userId = event.source.userId;
                                                                                                                                          let userName = "用戶";
                                                                                                                                              try {
                                                                                                                                                    if (event.source.groupId) {
                                                                                                                                                            const profile = await lineClient.getGroupMemberProfile(event.source.groupId, userId);
                                                                                                                                                                    userName = profile.displayName;
                                                                                                                                                                          } else {
                                                                                                                                                                                  const profile = await lineClient.getProfile(userId);
                                                                                                                                                                                          userName = profile.displayName;
                                                                                                                                                                                                }
                                                                                                                                                                                                    } catch {}
                                                                                                                                                                                                        const session = getSession(sourceId);
                                                                                                                                                                                                            try {
                                                                                                                                                                                                                  const result = await analyzeMessage(text, userName);
                                                                                                                                                                                                                        let replyText = result.reply || "";
                                                                                                                                                                                                                              if (result.action === "add" && result.payment?.amount) {
                                                                                                                                                                                                                                      const payerName = result.payment.payer === "我" ? userName : result.payment.payer;
                                                                                                                                                                                                                                              session.payments.push({ payer: payerName, amount: result.payment.amount, description: result.payment.description || "" });
                                                                                                                                                                                                                                                      replyText = replyText.replace(/^我/, userName);
                                                                                                                                                                                                                                                            } else if (result.action === "summary") {
                                                                                                                                                                                                                                                                    replyText = buildSummaryText(session);
                                                                                                                                                                                                                                                                          } else if (result.action === "list") {
                                                                                                                                                                                                                                                                                  replyText = buildListText(session);
                                                                                                                                                                                                                                                                                        } else if (result.action === "clear") {
                                                                                                                                                                                                                                                                                                session.payments = [];
                                                                                                                                                                                                                                                                                                        replyText = "🗑️ 已清空所有帳目，開始新的一餐吧！";
                                                                                                                                                                                                                                                                                                              } else if (result.action === "help") {
                                                                                                                                                                                                                                                                                                                      replyText = HELP_TEXT;
                                                                                                                                                                                                                                                                                                                            }
                                                                                                                                                                                                                                                                                                                                  if (replyText) {
                                                                                                                                                                                                                                                                                                                                          await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: replyText }] });
                                                                                                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                                                                                                    } catch (err) {
                                                                                                                                                                                                                                                                                                                                                          console.error("Error:", err);
                                                                                                                                                                                                                                                                                                                                                                await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "抱歉，發生錯誤 😅 請再試一次" }] }).catch(() => {});
                                                                                                                                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                                                                                                      });
                                                                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                                                                      app.get("/", (req, res) => res.send("Split Bill Bot is running! 🍽️"));
                                                                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                                                                      const PORT = process.env.PORT || 3000;
                                                                                                                                                                                                                                                                                                                                                                      app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
