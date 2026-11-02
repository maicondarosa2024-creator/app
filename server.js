// API intermediária: Mercado Livre (OAuth + dados) + agentes Claude
// Rode: npm install && npm run setup && npm start
// Env: ML_APP_ID, ML_SECRET, ML_REDIRECT (ex: https://sua-api.com/auth/callback),
//      ANTHROPIC_API_KEY, APP_ORIGIN (URL do app, para CORS), PORT
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import Anthropic from "@anthropic-ai/sdk";

const { ML_APP_ID, ML_SECRET, ML_REDIRECT, APP_ORIGIN, PORT = 3000 } = process.env;
const ML = "https://api.mercadolibre.com";
const claude = new Anthropic();
const app = express();
app.use(express.json());
app.use(cookieParser());
if (APP_ORIGIN) app.use(cors({ origin: APP_ORIGIN, credentials: true }));
app.use(express.static("public")); // serve o app no mesmo endereço da API
app.get("/health", (_, res) => res.json({ ok: true }));

// Sessões em memória (troque por Redis/Postgres em produção e criptografe os tokens)
const sessions = new Map(); // sid -> { access, refresh, expires, userId }

// ---------- OAuth Mercado Livre ----------
app.get("/auth/login", (req, res) =>
  res.redirect(`https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_APP_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT)}`));

async function tokenCall(params) {
  const r = await fetch(`${ML}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: ML_APP_ID, client_secret: ML_SECRET, ...params }),
  });
  if (!r.ok) throw new Error("Falha OAuth: " + (await r.text()));
  return r.json();
}

app.get("/auth/callback", async (req, res) => {
  const t = await tokenCall({ grant_type: "authorization_code", code: req.query.code, redirect_uri: ML_REDIRECT });
  const sid = crypto.randomUUID();
  sessions.set(sid, { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000, userId: t.user_id });
  res.cookie("sid", sid, { httpOnly: true, secure: true, sameSite: "none", maxAge: 30 * 864e5 });
  res.redirect(APP_ORIGIN || "/");
});

async function auth(req, res, next) {
  const s = sessions.get(req.cookies.sid);
  if (!s) return res.status(401).json({ error: "Faça login em /auth/login" });
  if (Date.now() > s.expires - 60000) {
    const t = await tokenCall({ grant_type: "refresh_token", refresh_token: s.refresh });
    Object.assign(s, { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000 });
  }
  req.s = s;
  next();
}

const ml = (s, path) => fetch(ML + path, { headers: { Authorization: `Bearer ${s.access}` } }).then(r => r.json());

// ---------- Ferramentas (chamam a API do Mercado Livre) ----------
const TOOLS = {
  search_items: { d: "Busca anúncios no Mercado Livre Brasil", p: { q: { type: "string" }, limit: { type: "number" } }, req: ["q"],
    run: (s, { q, limit = 10 }) => ml(s, `/sites/MLB/search?q=${encodeURIComponent(q)}&limit=${limit}`).then(d => d.results?.map(i => ({ id: i.id, titulo: i.title, preco: i.price, vendedor: i.seller?.id, frete_gratis: i.shipping?.free_shipping, vendidos: i.sold_quantity, link: i.permalink }))) },
  get_item: { d: "Detalhes de um anúncio", p: { id: { type: "string" } }, req: ["id"], run: (s, { id }) => ml(s, `/items/${id}`) },
  get_seller: { d: "Reputação de um vendedor", p: { id: { type: "string" } }, req: ["id"], run: (s, { id }) => ml(s, `/users/${id}`).then(u => ({ apelido: u.nickname, reputacao: u.seller_reputation })) },
  my_items: { d: "Lista anúncios do vendedor logado", p: {}, req: [], run: s => ml(s, `/users/${s.userId}/items/search`) },
  my_questions: { d: "Perguntas não respondidas do vendedor", p: {}, req: [], run: s => ml(s, `/questions/search?seller_id=${s.userId}&status=UNANSWERED`) },
  my_orders: { d: "Pedidos recentes do vendedor", p: {}, req: [], run: s => ml(s, `/orders/search?seller=${s.userId}&sort=date_desc`) },
};

// ---------- Agentes especialistas ----------
const AGENTS = {
  preco: { tools: ["search_items", "get_item", "my_items"], sys: "Você é especialista em precificação no Mercado Livre. Compare concorrentes, calcule posição de preço e sugira valores com justificativa. Nunca altere preços sem confirmação." },
  anuncio: { tools: ["get_item", "search_items", "my_items"], sys: "Você é especialista em SEO e conversão de anúncios do Mercado Livre. Sugira títulos (até 60 caracteres), descrição e atributos." },
  atend: { tools: ["my_questions", "get_item"], sys: "Você atende compradores pelo vendedor: redija respostas educadas, claras e precisas. Apenas rascunhe; o vendedor aprova o envio." },
  pedidos: { tools: ["my_orders", "get_item"], sys: "Você acompanha pedidos e envios: priorize atrasos e riscos de reclamação." },
  ofertas: { tools: ["search_items", "get_item", "get_seller"], sys: "Você ajuda compradores a achar o melhor custo-benefício. Compare preço, frete, reputação e avaliações, e explique a escolha." },
  vendedor: { tools: ["get_seller", "get_item"], sys: "Você avalia a confiabilidade de vendedores do Mercado Livre e aponta sinais de risco com base na reputação." },
};

app.post("/api/agents/:id/chat", auth, async (req, res) => {
  const agent = AGENTS[req.params.id];
  if (!agent) return res.status(404).json({ error: "Agente inexistente" });
  const tools = agent.tools.map(n => ({ name: n, description: TOOLS[n].d, input_schema: { type: "object", properties: TOOLS[n].p, required: TOOLS[n].req } }));
  const messages = [{ role: "user", content: req.body.message }];
  try {
    for (let i = 0; i < 6; i++) {
      const r = await claude.messages.create({ model: "claude-sonnet-5-5", max_tokens: 1500, system: agent.sys + " Responda em português do Brasil, de forma curta.", tools, messages });
      if (r.stop_reason !== "tool_use") return res.json({ reply: r.content.filter(b => b.type === "text").map(b => b.text).join("\n") });
      messages.push({ role: "assistant", content: r.content });
      const results = [];
      for (const b of r.content.filter(b => b.type === "tool_use"))
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(await TOOLS[b.name].run(req.s, b.input)).slice(0, 12000) });
      messages.push({ role: "user", content: results });
    }
    res.json({ reply: "Não consegui concluir a análise." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erro no agente" }); }
});

app.listen(PORT, () => console.log("API na porta " + PORT));
