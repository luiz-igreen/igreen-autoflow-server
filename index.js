const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES GERAIS E CHAVES
// ==========================================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "F177679f2434d425e9a3e58ddec1d4cf0S"; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyCz1JE0Ie6HsAocCfx16gy2x29rkV3OMPw"; 

const IGREEN_ESCRITORIO_URL = "https://escritorio.igreenenergy.com.br"; 

const IGREEN_USER = "jorgeluizhouse@hotmail.com";
const IGREEN_PASS = "@@Lkjdsa12345";

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
    T_RESGATE_START: "⚡ *Módulo de Extração de Dados* ativado! Digite apenas o *Nome ou ID* do cliente (Ex: Wellington Silva ou 398172):",
    T_RESGATE_BUSCANDO: "🔍 O Robô Fantasma está a invadir o *Escritório Virtual iGreen* em background para capturar o CPF e Nascimento do cliente. Isto leva cerca de 25 a 30 segundos...",
    T_RESGATE_FAIL: "⚠️ O Robô não conseguiu extrair os dados. Verifique se o ID está correto ou tente pelo Nome do Cliente. (Veja os logs na tela preta)"
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
// FUNÇÕES AUXILIARES E IA
// ==========================================
async function extrairDadosFatura(fileUrl, isPdf) {
    if (!GEMINI_API_KEY) return null;
    try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const base64Data = Buffer.from(response.data, 'binary').toString('base64');
        const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';
        const dataHoje = new Date().toLocaleDateString('pt-BR');
        
        const prompt = `Você é um auditor da iGreen. Extraia da fatura: "NOME_CLIENTE", "CEP", "MEDIA_CONSUMO" (int), "UC", "DATA_VENCIMENTO" (DD/MM/AAAA), "FATURA_VENCIDA" (boolean). Retorne apenas JSON válido.`;
        
        const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64Data } }] }], generationConfig: { responseMimeType: "application/json" } };
        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`, payload);
        return JSON.parse(geminiRes.data.candidates[0].content.parts[0].text);
    } catch (error) { return null; }
}

async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { 
        console.log(`[Z-API] Tentando enviar mensagem para ${numLimpo}...`);
        await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numLimpo, message: String(message) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }); 
        console.log(`[Z-API] ✅ Mensagem enviada com sucesso!`);
    } catch (e) {
        console.error(`[Z-API] ❌ Erro ao enviar mensagem:`, e.message);
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
// MÓDULO: EXTRATOR INTELIGENTE DE DADOS (V83 - Digitação Humana + Enter)
// ==========================================
async function fluxoExtracaoDados(termoBusca, phone) {
    let browser;
    try {
        console.log(`[EXTRATOR] ⚠️ Tentando alocar memória e iniciar Navegador Fantasma V83...`);
        browser = await puppeteer.launch({ headless: "new", args: CHROME_ARGS });
        
        console.log(`[EXTRATOR] ✅ Navegador aberto. Criando nova aba com resolução Full HD...`);
        const page = await browser.newPage();
        
        // V81 FIX: Resolução GIGANTE para garantir que a iGreen não oculta nenhuma coluna
        await page.setViewport({ width: 1920, height: 1080 });
        
        console.log(`[EXTRATOR] 1. Acessando Escritório: ${IGREEN_ESCRITORIO_URL}`);
        await page.goto(IGREEN_ESCRITORIO_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log(`[EXTRATOR] Fazendo Login...`);
        await page.evaluate((u, p) => {
            const emailInput = document.querySelector('input[type="email"], input[placeholder*="e-mail" i]');
            const passInput = document.querySelector('input[type="password"], input[placeholder*="senha" i]');
            if(emailInput) { emailInput.value = u; emailInput.dispatchEvent(new Event('input')); }
            if(passInput) { passInput.value = p; passInput.dispatchEvent(new Event('input')); }
            const btnLogin = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar'));
            if(btnLogin) btnLogin.click();
        }, IGREEN_USER, IGREEN_PASS);
        
        await new Promise(r => setTimeout(r, 6000));

        console.log(`[EXTRATOR] 2. Navegando para Relatórios...`);
        await page.evaluate(() => {
            const btnRelatorios = Array.from(document.querySelectorAll('div, span, button, a')).find(e => e.textContent.trim() === 'Relatórios');
            if(btnRelatorios) btnRelatorios.click();
        });
        await new Promise(r => setTimeout(r, 1500));
        
        console.log(`[EXTRATOR] Clicando em Mapa de Clientes...`);
        await page.evaluate(() => {
            const btnMapa = Array.from(document.querySelectorAll('div, span, a')).find(e => e.textContent.trim() === 'Mapa de Clientes');
            if(btnMapa) btnMapa.click();
        });
        await new Promise(r => setTimeout(r, 6000)); // Espera a tela de mapa de clientes carregar

        console.log(`[EXTRATOR] 3. Pesquisando alvo: ${termoBusca}`);
        
        // V83 FIX: Digitação Humana Real + Tecla Enter Física do Teclado
        const searchSelector = 'input[placeholder*="Pesquisar" i], input[placeholder*="Buscar" i]';
        
        // Espera a caixa de pesquisa existir na tela e clica nela fisicamente
        await page.waitForSelector(searchSelector, { timeout: 15000 });
        await page.click(searchSelector);
        
        // Limpa a caixa por precaução via código
        await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, searchSelector);
        
        // Digita o ID/Nome como se fosse um humano (com pausa de 150ms entre as teclas para não assustar o site)
        await page.type(searchSelector, termoBusca, { delay: 150 });
        
        // Aperta fisicamente a tecla ENTER do teclado do servidor Render!
        console.log(`[EXTRATOR] Apertando ENTER para forçar o filtro...`);
        await page.keyboard.press('Enter');
        
        console.log(`[EXTRATOR] Aguardando a tabela atualizar após o Enter (10s)...`);
        await new Promise(r => setTimeout(r, 10000)); 

        // V82 FIX: OS ÓCULOS DO ROBÔ (Loga o que ele está vendo na tela preta)
        console.log(`[EXTRATOR] Usando visão de Raio-X na tabela...`);
        const visaoRobo = await page.evaluate(() => {
            const tbody = document.querySelector('tbody');
            if(!tbody) return "NENHUMA TABELA ENCONTRADA NA TELA";
            return tbody.innerText.replace(/\n/g, ' | ').substring(0, 400); // Pega os primeiros 400 caracteres
        });
        console.log(`[OLHOS DO ROBO]: ${visaoRobo}`);

        console.log(`[EXTRATOR] 4. Lendo a Primeira Linha Filtrada...`);
        const dadosExtraidos = await page.evaluate(() => {
            // Captura todas as linhas da tabela
            const linhas = Array.from(document.querySelectorAll('tbody tr'));
            if (linhas.length === 0 || linhas[0].textContent.includes('Nenhum')) return null;

            // Como a busca do Enter filtrou, pegamos logo a PRIMEIRA linha que sobrou!
            const linhaCorreta = linhas[0];
            const colunas = linhaCorreta.querySelectorAll('td');
            
            let nome = "Cliente Localizado";
            let cpf = "Não encontrado";
            let nasc = "Não encontrado";
            
            // A Lógica de Mapeamento LUIZ JORGE (Col 9 e Col 19)
            if (colunas.length >= 10) {
                nome = colunas[1] ? colunas[1].textContent.trim() : nome;
                cpf = colunas[8] ? colunas[8].textContent.trim() : cpf;
            }
            if (colunas.length >= 19) {
                nasc = colunas[18] ? colunas[18].textContent.trim() : nasc;
            }

            // PLANO B: Se a tabela for diferente, o robô passa o Radar (Regex) na linha inteira!
            if (cpf === "Não encontrado" || cpf === "") {
                let textoLinha = linhaCorreta.textContent;
                let regexCpf = textoLinha.match(/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
                cpf = regexCpf ? regexCpf[0] : "Não encontrado";
            }
            
            if (nasc === "Não encontrado" || nasc === "") {
                let textoLinha = linhaCorreta.textContent;
                let regexDatas = textoLinha.match(/\d{2}\/\d{2}\/\d{4}/g);
                // Pega a última data encontrada na linha (que geralmente é a de nascimento)
                nasc = regexDatas ? regexDatas[regexDatas.length - 1] : "Não encontrado";
            }

            return { nome, cpf, nasc };
        });

        console.log(`[EXTRATOR] Fechando navegador para liberar memória...`);
        await browser.close();

        // Se não achou o CPF
        if (!dadosExtraidos || dadosExtraidos.cpf === "Não encontrado") {
            await enviarMensagem(phone, TEXTOS.T_RESGATE_FAIL);
            return;
        }

        console.log(`[EXTRATOR] 🎉 Dados capturados! Enviando para o WhatsApp...`);
        const mensagemFinal = `✅ *DADOS CAPTURADOS COM SUCESSO!* 🕵️‍♂️\n\n` +
                              `👤 *Nome:* ${dadosExtraidos.nome}\n` +
                              `📄 *Documento:* ${dadosExtraidos.cpf}\n` +
                              `🎂 *Nascimento:* ${dadosExtraidos.nasc}\n\n` +
                              `⚡ *Atalhos das Concessionárias:*\n` +
                              `➡️ *Equatorial AL:* https://al.equatorialenergia.com.br/sua-conta/segunda-via/\n` +
                              `➡️ *Cemig MG:* https://atendimento.cemig.com.br/`;

        await enviarMensagem(phone, mensagemFinal);

    } catch (error) {
        console.error("❌ [ERRO EXTRATOR FATAL]:", error.message);
        await enviarMensagem(phone, `⚠️ Ocorreu um erro técnico ao aceder ao Escritório Virtual. Tente novamente em 2 minutos.`);
        if(browser) await browser.close();
    }
}

// ==========================================
// LÓGICA DO WEBHOOK
// ==========================================
app.post('/webhook/igreen', async (req, res) => {
    // Responde ao Z-API na hora para não dar timeout
    res.status(200).send("OK");
    
    const data = req.body;
    if (data.fromMe) return;

    const phone = data.phone;
    if (data.isGroup || String(phone).toLowerCase().includes('group') || String(phone).toLowerCase().includes('@g.us')) return;

    const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl) || (data.photo && data.photo.photoUrl);
    const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
    const fileUrl = data.image?.imageUrl || data.document?.documentUrl;
    const textoIn = data.text?.message?.trim() || "";
    const txtL = textoIn.toLowerCase();

    console.log(`[WEBHOOK] Mensagem recebida de ${phone}: ${txtL}`);

    if (['novo', 'nova'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', IS_ATUALIZACAO: false });
        await enviarMensagem(phone, TEXTOS.T01); return;
    }
    if (['resgatar', 'dados', 'puxar'].includes(txtL)) {
        memoriaEstado.delete(phone);
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TERMO_RESGATE' });
        await enviarMensagem(phone, TEXTOS.T_RESGATE_START); return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };

    switch (mem.STATUS_CADASTRO) {
        case 'AGUARDANDO_TERMO_RESGATE':
            if (textoIn.length > 2) {
                console.log(`[FLUXO] Usuário pediu busca por: ${textoIn}`);
                await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO);
                memoriaEstado.delete(phone); 

                console.log(`[SISTEMA] Aguardando 3 segundos para estabilizar memória RAM...`);
                setTimeout(() => {
                    fluxoExtracaoDados(textoIn, phone);
                }, 3000);
            } else {
                await enviarMensagem(phone, "⚠️ Termo muito curto. Digite o Nome ou ID:");
            }
            break;
            
        case 'AGUARDANDO_FATURA':
            if (!isImage && !isPDF) { await enviarMensagem(phone, "Por favor, envie a foto/PDF da fatura."); return; }
            await enviarMensagem(phone, TEXTOS.T02);
            const dadosExtraidos = await extrairDadosFatura(fileUrl, isPDF);
            
            if (dadosExtraidos) {
                mem = { ...mem, ...dadosExtraidos, LINK_FATURA: fileUrl };
                mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_FRENTE';
                setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T04); }, 3000);
            } else {
                mem = { ...mem, LINK_FATURA: fileUrl, STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' };
                setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T04); }, 3000);
            }
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            break;

        case 'AGUARDANDO_DOC_FRENTE':
            if (!isImage && !isPDF) return;
            mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_VERSO';
            mem.LINK_DOC_FRENTE = fileUrl;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T05);
            break;

        case 'AGUARDANDO_DOC_VERSO':
            if (!isImage && !isPDF) return;
            mem.STATUS_CADASTRO = 'AGUARDANDO_EMAIL';
            mem.LINK_DOC_VERSO = fileUrl;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T06);
            setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T07); }, 4000);
            break;

        case 'AGUARDANDO_EMAIL':
            if (isImage || isPDF) return;
            mem.EMAIL = textoIn;
            mem.STATUS_CADASTRO = 'CONCLUIDO';
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T08);
            memoriaEstado.delete(phone); 
            break;
    }
});

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V83 ONLINE (Enter Física + Visão de Águia)`));  
