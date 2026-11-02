// Assistente: pergunta as chaves e gera o arquivo .env
import readline from "node:readline/promises";
import fs from "node:fs";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("\n🛒 Configuração do ML Agentes\n");
console.log("Crie seu app em https://developers.mercadolivre.com.br/devcenter (Criar aplicação).");
console.log("Chave da Anthropic: https://console.anthropic.com/settings/keys\n");
const url = (await rl.question("Endereço público do app (ex: https://meuapp.onrender.com) [http://localhost:3000]: ")).trim().replace(/\/$/, "") || "http://localhost:3000";
console.log(`\n➡ No Mercado Livre, use esta URL de redirecionamento: ${url}/auth/callback\n`);
const id = await rl.question("ML App ID: ");
const secret = await rl.question("ML Secret Key: ");
const key = await rl.question("Anthropic API Key: ");
fs.writeFileSync(".env", `ML_APP_ID=${id.trim()}\nML_SECRET=${secret.trim()}\nML_REDIRECT=${url}/auth/callback\nANTHROPIC_API_KEY=${key.trim()}\nPORT=3000\n`);
console.log("\n✅ .env criado. Agora rode: npm start\n");
rl.close();
