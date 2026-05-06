import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES GERAIS E CHAVES
// ==========================================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "F177679f2434d425e9a3e58ddec1d4cf0S"; 

// V97: Usando os links diretos mapeados pelo Luiz Jorge
const IGREEN_LOGIN_URL = "https://escritorio.igreenenergy.com.br/login"; 
const IGREEN_MAPA_URL = "https://escritorio.igreenenergy.com.br/mapa-clientes";

const IGREEN_USER = process.env.IGREEN_USER || "jorgeluizhouse@hotmail.com";
const IGREEN_PASS = process.env.IGREEN_PASS || "@@Lkjdsa12345";

const APP_ID = 'igreen-autoflow-v4';

try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig && admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    console.log("✅ Banco de Dados Cloud ligado!");
  }
} catch (e) { console.error("Erro DB:", e.message); }

const memoriaEstado = new Map();

const TEXTOS = {
    T01: "Seja muito bem-vindo(a) ao Atendimento VIP da iGreen Energy! 🌿 Para prepararmos o seu desconto, por favor, me envie uma foto bem nítida (ou PDF) da sua conta de luz mais recente.",
    T02: "Recebemos a sua fatura! Extraindo os seus dados de consumo. Um momento...",
    T04: "Fatura validada! ✅ Para finalizarmos a documentação antifraude, envie uma foto nítida apenas da FRENTE do seu RG ou CNH.",
    T05: "Frente guardada. Agora, envie a foto do VERSO do documento.",
    T06: "Excelente! Os documentos estão sendo encriptados.",
    T07: "Para podermos registrar o seu cadastro, digite o seu melhor e-mail:",
    T08: "Tudo pronto! 🎉 A nossa inteligência entregou toda a sua documentação na base da iGreen Energy. Eles enviarão o link oficial para assinatura em breve! 🌿",
    T_RESGATE_START: "⚡ *Módulo de Extração de Dados* ativado! Digite apenas o *Nome ou ID* do cliente (Ex: Robson Carlos ou 1119032):",
    T_RESGATE_BUSCANDO: "🔍 O Robô Fantasma está a usar a Navegação Direta no *Escritório Virtual iGreen*. Isto leva cerca de 20 a 30 segundos...",
    T_RESGATE_FAIL: "⚠️ O Robô varreu toda a tela da iGreen, mas o cliente não possui CPF registado na plataforma ou a busca falhou."
};

const CHROME_ARGS = [
    "--no-sandbox", 
    "--disable-setuid-sandbox", 
    "--disable-dev-shm-usage", 
    "--disable-gpu",
    "--single-process",
    "--no-zygote",
    "--js-flags=--expose-gc"
];

// ==========================================
// FUNÇÕES AUXILIARES (Z-API BLINDADA)
// ==========================================
async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { 
        console.log(`[Z-API] Enviando mensagem para ${numLimpo}...`);
        await axios.post(
            `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
            { phone: numLimpo, message: String(message) }, 
            { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' } }
        ); 
    } catch (e) {
        console.error(`[Z-API] ❌ Erro ao enviar mensagem:`, e.response?.data || e.message);
    }
}

async function salvarNoBanco(phone, dados) {
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(phone).set({ ...dados, TELEFONE: phone, DATA_PROCESSAMENTO: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        } catch (e) {}
    }
}

// ==========================================
// MÓDULO: EXTRATOR V97 (DEEP LINKING + ES6)
// ==========================================
async function fluxoExtracaoDados(termoBusca, phone) {
    let browser;
    try {
        console.log(`[EXTRATOR] ⚠️ Iniciando Navegador Fantasma V97...`);
        browser = await puppeteer.launch({ headless: "new", args: CHROME_ARGS });
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        // 1. VAI DIRETO PARA A TELA DE LOGIN
        console.log(`[EXTRATOR] 1. Acessando Login da iGreen: ${IGREEN_LOGIN_URL}`);
        await page.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log(`[EXTRATOR] Fazendo Login...`);
        const emailSel = 'input[type="email"], input[placeholder*="e-mail" i], input[name*="email" i]';
        const passSel = 'input[type="password"], input[placeholder*="senha" i], input[name*="pass" i]';
        await page.waitForSelector(emailSel, { timeout: 15000 });
        
        await page.click(emailSel, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type(emailSel, IGREEN_USER, { delay: 50 });
        
        await page.click(passSel, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type(passSel, IGREEN_PASS, { delay: 50 });
        
        const btnLoginEncontrado = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => b.innerText.toLowerCase().includes('entrar') || b.innerText.toLowerCase().includes('acessar'));
            if (btn) { btn.id = "btn_login_igreen_injetor"; return true; }
            return false;
        });

        if (btnLoginEncontrado) await page.click('#btn_login_igreen_injetor');
        else await page.keyboard.press('Enter');
        
        console.log(`[EXTRATOR] Aguardando autenticação...`);
        await new Promise(r => setTimeout(r, 6000));

        // 2. NAVEGAÇÃO DIRETA AO MAPA
        console.log(`[EXTRATOR] 2. Navegação Direta (Deep Link) para: ${IGREEN_MAPA_URL}`);
        await page.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log(`[EXTRATOR] Aguardando a tabela de clientes carregar...`);
        await new Promise(r => setTimeout(r, 8000)); 

        // 3. PESQUISA NA TABELA
        console.log(`[EXTRATOR] 3. Pesquisando alvo: ${termoBusca}`);
        const searchSelector = 'input[placeholder*="Pesquisar" i], input[placeholder*="Buscar" i]';
        const searchInput = await page.waitForSelector(searchSelector, { timeout: 15000 });
        
        await searchInput.click({ clickCount: 3 }); 
        await page.keyboard.press('Backspace'); 
        await new Promise(r => setTimeout(r, 500));
        await page.type(searchSelector, termoBusca, { delay: 100 });
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');
        
        console.log(`[EXTRATOR] 4. Iniciando Varredura Anti-Duplicidade (Polling)...`);
        
        let dadosExtraidos = null;
        let textoDeErro = "";

        // Tenta ler a tabela 6 vezes (a cada 2 segundos)
        for (let tentativa = 1; tentativa <= 6; tentativa++) {
            console.log(`[EXTRATOR] Varredura ${tentativa}/6...`);
            
            dadosExtraidos = await page.evaluate((busca) => {
                const areaBusca = document.querySelector('tbody') || document.querySelector('table') || document.body;
                const textoGigante = areaBusca.innerText || "";
                
                if (textoGigante.includes('Nenhum registro') || textoGigante.trim() === '') {
                    return { cpf: "Não encontrado", raw: textoGigante.substring(0, 150) };
                }

                const padraoCpf = textoGigante.match(/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
                const cpfFinal = padraoCpf ? padraoCpf[0] : "Não encontrado";

                const padraoDatas = textoGigante.match(/\d{2}\/\d{2}\/\d{4}/g);
                let nascFinal = "Não consta no sistema";
                if (padraoDatas) {
                    const datasAntigas = padraoDatas.filter(d => parseInt(d.split('/')[2]) < 2010);
                    if (datasAntigas.length > 0) nascFinal = datasAntigas[0];
                }

                let nomeFinal = "Cliente Localizado";
                const linhas = Array.from(areaBusca.querySelectorAll('tr'));
                const linhaCorreta = linhas.find(tr => tr.innerText.includes(busca) || (cpfFinal !== "Não encontrado" && tr.innerText.includes(cpfFinal)));
                
                if (linhaCorreta) {
                    const tds = Array.from(linhaCorreta.querySelectorAll('td, th'));
                    for (let td of tds) {
                        let txt = td.innerText.trim();
                        if (txt.length > 6 && !/\d/.test(txt) && txt.toUpperCase() === txt && txt !== "ATIVO" && txt !== "VALIDADO") {
                            nomeFinal = txt;
                            break; 
                        }
                    }
                }

                return { nome: nomeFinal, cpf: cpfFinal, nasc: nascFinal, raw: "" };
            }, termoBusca);

            if (dadosExtraidos && dadosExtraidos.cpf !== "Não encontrado") {
                console.log(`[EXTRATOR] Dados encontrados com sucesso na varredura ${tentativa}!`);
                break;
            }

            textoDeErro = dadosExtraidos ? dadosExtraidos.raw : "Tela vazia";
            await new Promise(r => setTimeout(r, 2000));
        }

        await browser.close();

        if (!dadosExtraidos || dadosExtraidos.cpf === "Não encontrado") {
            await enviarMensagem(phone, TEXTOS.T_RESGATE_FAIL + `\n\n🔍 *Raio-X (Tela)*: ${textoDeErro}`);
            return;
        }

        console.log(`[EXTRATOR] 🎉 Montando mensagem final para o WhatsApp...`);
        const mensagemFinal = `✅ *DADOS CAPTURADOS COM SUCESSO!* 🕵️‍♂️\n\n` +
                              `👤 *Nome:* ${dadosExtraidos.nome}\n` +
                              `📄 *Documento:* ${dadosExtraidos.cpf}\n` +
                              `🎂 *Nascimento:* ${dadosExtraidos.nasc}\n\n` +
                              `⚡ *Atalhos das Concessionárias:*\n` +
                              `➡️ *Equatorial AL:* https://al.equatorialenergia.com.br/sua-conta/segunda-via/\n` +
                              `➡️ *Cemig MG:* https://atendimento.cemig.com.br/`;

        await enviarMensagem(phone, mensagemFinal);

    } catch (error) {
        console.error("❌ [ERRO EXTRATOR V97]:", error.message);
        await enviarMensagem(phone, `⚠️ O servidor teve um soluço técnico: ${error.message}`);
        if(browser) await browser.close();
    }
}

// ==========================================
// LÓGICA DO WEBHOOK
// ==========================================
app.post('/webhook/igreen', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    if (data.fromMe) return;

    const phone = data.phone;
    const textoIn = data.text?.message?.trim() || "";
    const txtL = textoIn.toLowerCase();

    console.log(`[WEBHOOK] Mensagem recebida de ${phone}: ${txtL}`);

    if (['novo', 'nova'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', IS_ATUALIZACAO: false });
        await enviarMensagem(phone, TEXTOS.T01); return;
    }
    if (['resgatar', 'dados', 'puxar'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TERMO_RESGATE' });
        await enviarMensagem(phone, TEXTOS.T_RESGATE_START); return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };

    switch (mem.STATUS_CADASTRO) {
        case 'AGUARDANDO_TERMO_RESGATE':
            if (textoIn.length > 2) {
                await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO);
                memoriaEstado.delete(phone); 
                setTimeout(() => { fluxoExtracaoDados(textoIn, phone); }, 3000);
            }
            break;
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 SERVIDOR V97 ONLINE (Módulos Modernos ES6)`));
