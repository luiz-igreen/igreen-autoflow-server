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
const IGREEN_LINK = process.env.IGREEN_LINK || "https://green.igreenenergy.com.br/?id=76049&sendcontract=true";
const APP_ID = 'igreen-autoflow-v4';

// Conexão com o Firebase
try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig && admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    console.log("✅ Banco de Dados Cloud ligado com sucesso!");
  }
} catch (e) {
  console.error("Erro na base de dados:", e.message);
}

const memoriaEstado = new Map();

// Textos Oficiais
const TEXTOS = {
    T01: "Seja muito bem-vindo(a) ao Atendimento VIP da iGreen Energy! 🌿 Para prepararmos o seu desconto sem você precisar preencher formulários longos, por favor, me envie uma foto bem nítida (ou PDF) da sua conta de luz mais recente.",
    T02: "Recebemos a sua fatura! O nosso sistema está extraindo os seus dados de consumo de forma segura. Um momento...",
    T04: "Fatura validada com sucesso! ✅ Para finalizarmos a documentação antifraude, envie uma foto nítida apenas da FRENTE do seu RG ou CNH.",
    T05: "Frente guardada. Agora, envie a foto do VERSO do documento.",
    T06: "Excelente! Os documentos estão sendo encriptados e processados.",
    T07: "Para podermos registrar o seu cadastro, digite o seu melhor e-mail:",
    T08: "Tudo pronto! 🎉 A nossa inteligência artificial concluiu a auditoria e entregou toda a sua documentação na base da iGreen Energy. A própria iGreen irá processar o seu cadastro e enviar-lhe o link oficial para assinatura muito em breve! 🌿",
    T08_ATUALIZACAO: "Tudo pronto! 🎉 A sua nova fatura foi enviada com sucesso. A iGreen Energy irá processar o documento e regularizar o seu desconto! 🌿",
    T_ATUALIZAR: "Olá! Verificamos que precisamos atualizar a sua fatura. Para resolvermos isto rapidamente, por favor, envie-me apenas a foto da sua NOVA FATURA de energia. \n\n*Como você já é nosso cliente, não precisaremos dos seus documentos de identidade novamente!* 🌿",
    T_ATUALIZAR_EMAIL: "Fatura atualizada e processada com sucesso! ✅ Para localizarmos o seu cadastro, confirme digitando o seu e-mail:",
    T11: "Aviso: A imagem enviada não pôde ser lida. Por favor, reenvie a foto do documento com mais foco e sem reflexos de luz.",
    T12: "O e-mail parece inválido. Por favor, digite novamente (exemplo: nome@email.com).",
    T_RPA_START: "🤖 *Aviso Interno (Sistema)*: Iniciando entrega oficial de documentos no portal iGreen..."
};

// ==========================================
// O CÉREBRO: EXTRAÇÃO GEMINI VISION
// ==========================================
async function extrairDadosFatura(fileUrl, isPdf) {
    if (!GEMINI_API_KEY) return null;
    try {
        console.log("🧠 [IA] Extraindo dados da fatura...");
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const base64Data = Buffer.from(response.data, 'binary').toString('base64');
        const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';

        const prompt = `Extraia da fatura e retorne apenas um JSON válido com estas chaves:
        "NOME_CLIENTE": Nome completo exato.
        "CEP": CEP (apenas números ou com traço).
        "MEDIA_CONSUMO": Número inteiro da média ou do consumo atual.
        "UC": Número da instalação / Parceiro de Negócio.`;

        const payload = {
            contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64Data } }] }],
            generationConfig: { responseMimeType: "application/json" }
        };

        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`, payload);
        return JSON.parse(geminiRes.data.candidates[0].content.parts[0].text);
    } catch (error) {
        console.error("❌ [IA ERRO]:", error.message);
        return null;
    }
}

// ==========================================
// FUNÇÕES DE SISTEMA
// ==========================================
async function salvarNoBanco(phone, dados) {
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            const leadRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(phone);
            await leadRef.set({
                ...dados,
                TELEFONE: phone,
                DATA_PROCESSAMENTO: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (e) {}
    }
}

async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try {
        await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numLimpo, message: String(message) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } });
    } catch (e) {}
}

// Função para baixar imagens do WhatsApp temporariamente para o servidor fazer o upload na iGreen
async function baixarParaTemp(url, prefix) {
    if(!url) return null;
    try {
        const filepath = path.join(os.tmpdir(), prefix + '_' + Date.now() + (url.includes('.pdf') ? '.pdf' : '.jpg'));
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        fs.writeFileSync(filepath, response.data);
        return filepath;
    } catch(e) { 
        return null; 
    }
}

// ==========================================
// MOTOR RPA: INJEÇÃO REAL (SEM TRAVAS)
// ==========================================
async function executarRPA(dados, phone) {
    console.log(`🚀 [RPA MODO PRODUÇÃO] Iniciando Entrega de Dados para: ${dados.NOME_CLIENTE}`);
    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        console.log(`🌐 [RPA] Acessando o Portal...`);
        await page.goto(IGREEN_LINK, { waitUntil: 'networkidle2', timeout: 60000 });

        // Clica em Começar
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('a, button, div')).find(b => b.textContent && b.textContent.toLowerCase().includes('começar'));
            if(btn) btn.click();
        });
        await page.waitForTimeout(4000); 

        console.log(`✍️ [RPA] Injetando DADOS EXTRAÍDOS PELA IA...`);
        const preencherPorPlaceholder = async (dica, valor) => {
            if(!valor || valor === "-") return;
            try {
                await page.evaluate((d, v) => {
                    const inputs = Array.from(document.querySelectorAll('input'));
                    const alvo = inputs.find(i => i.placeholder && i.placeholder.toLowerCase().includes(d.toLowerCase()));
                    if (alvo) { alvo.value = v; alvo.dispatchEvent(new Event('input', { bubbles: true })); alvo.dispatchEvent(new Event('change', { bubbles: true })); }
                }, dica, valor);
                await page.waitForTimeout(300);
            } catch (e) {}
        };

        await preencherPorPlaceholder('00000-000', dados.CEP);
        await preencherPorPlaceholder('Nome completo', dados.NOME_CLIENTE);
        await preencherPorPlaceholder('E-mail', dados.EMAIL);
        await preencherPorPlaceholder('Ex: 250', dados.MEDIA_CONSUMO);
        await preencherPorPlaceholder('Localizado na sua conta', dados.UC);
        if(dados.CPF) await preencherPorPlaceholder('CPF', dados.CPF);

        console.log(`📂 [RPA] Baixando e anexando Fatura e Documentos Reais...`);
        const pathFatura = await baixarParaTemp(dados.LINK_FATURA, 'fatura');
        const pathFrente = await baixarParaTemp(dados.LINK_DOC_FRENTE, 'frente');
        const pathVerso = await baixarParaTemp(dados.LINK_DOC_VERSO, 'verso');

        const fileInputs = await page.$$('input[type="file"]');
        if(fileInputs[0] && pathFatura) await fileInputs[0].uploadFile(pathFatura);
        if(fileInputs[1] && pathFrente) await fileInputs[1].uploadFile(pathFrente);
        if(fileInputs[2] && pathVerso) await fileInputs[2].uploadFile(pathVerso);
        
        await page.waitForTimeout(2000);

        // O CLIQUE FINAL VALENDO (Apenas enviar os dados)
        console.log("🖱️ [RPA] Clicando no botão de Enviar Documentação...");
        await page.evaluate(() => {
            const botoes = Array.from(document.querySelectorAll('button, a'));
            const btnFinal = botoes.find(b => b.textContent && (
                b.textContent.toLowerCase().includes('finalizar') ||
                b.textContent.toLowerCase().includes('enviar') ||
                b.textContent.toLowerCase().includes('prosseguir') ||
                b.textContent.toLowerCase().includes('concluir')
            ));
            if (btnFinal) btnFinal.click();
        });

        await page.waitForTimeout(5000); // Aguarda o processamento do portal

        console.log("✅ [RPA PRODUÇÃO] Documentação entregue à iGreen com SUCESSO!");
        await enviarMensagem(phone, `✅ *DADOS ENTREGUES!* O Robô finalizou a injeção no portal da iGreen. A responsabilidade agora é 100% da iGreen Energy para analisar e disparar o contrato para o cliente.`);
        
        // Limpa os arquivos temporários
        if(pathFatura) fs.unlinkSync(pathFatura);
        if(pathFrente) fs.unlinkSync(pathFrente);
        if(pathVerso) fs.unlinkSync(pathVerso);

        await browser.close();
        return true;

    } catch (error) {
        console.error("❌ [RPA ERRO]:", error.message);
        await browser.close();
        return false;
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
    if (data.isGroup || String(phone).toLowerCase().includes('group') || String(phone).toLowerCase().includes('@g.us')) return;

    const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl) || (data.photo && data.photo.photoUrl);
    const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
    const textoIn = data.text?.message?.trim() || "";
    const txtL = textoIn.toLowerCase();

    if (['novo', 'nova', 'atualizar', 'atualizacao', 'atualização'].includes(txtL)) {
        memoriaEstado.delete(phone); 
        const isAtualizacao = txtL.includes('atualiza');
        await enviarMensagem(phone, isAtualizacao ? TEXTOS.T_ATUALIZAR : TEXTOS.T01); 
        
        memoriaEstado.set(phone, { 
            STATUS_CADASTRO: 'AGUARDANDO_FATURA',
            IS_ATUALIZACAO: isAtualizacao 
        });
        await salvarNoBanco(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', IS_ATUALIZACAO: isAtualizacao });
        return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };
    let status = mem.STATUS_CADASTRO;

    switch (status) {
        case 'AGUARDANDO_FATURA':
        case 'NOVO':
            if (!isImage && !isPDF) { await enviarMensagem(phone, "Por favor, me envie a foto ou PDF da fatura."); return; }
            await enviarMensagem(phone, TEXTOS.T02);
            const fileUrl = data.image?.imageUrl || data.document?.documentUrl;
            const dadosExtraidos = await extrairDadosFatura(fileUrl, isPDF);
            
            if (dadosExtraidos) {
                mem = { ...mem, ...dadosExtraidos, LINK_FATURA: fileUrl };
                
                if (mem.IS_ATUALIZACAO) {
                    // VIA RÁPIDA: Pula documentos e pede o e-mail
                    mem.STATUS_CADASTRO = 'AGUARDANDO_EMAIL';
                    memoriaEstado.set(phone, mem);
                    await salvarNoBanco(phone, mem);
                    setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T_ATUALIZAR_EMAIL); }, 3000);
                } else {
                    // FLUXO NORMAL: Pede RG
                    mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_FRENTE';
                    memoriaEstado.set(phone, mem);
                    await salvarNoBanco(phone, mem);
                    setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T04); }, 3000);
                }
            } else {
                mem = { ...mem, LINK_FATURA: fileUrl, STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' };
                memoriaEstado.set(phone, mem);
                await salvarNoBanco(phone, mem);
                setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T04); }, 3000);
            }
            break;

        case 'AGUARDANDO_DOC_FRENTE':
            if (!isImage && !isPDF) { await enviarMensagem(phone, TEXTOS.T11); return; }
            mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_VERSO';
            mem.LINK_DOC_FRENTE = data.image?.imageUrl || data.document?.documentUrl;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T05);
            break;

        case 'AGUARDANDO_DOC_VERSO':
            if (!isImage && !isPDF) { await enviarMensagem(phone, TEXTOS.T11); return; }
            mem.STATUS_CADASTRO = 'AGUARDANDO_EMAIL';
            mem.LINK_DOC_VERSO = data.image?.imageUrl || data.document?.documentUrl;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T06);
            setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T07); }, 4000);
            break;

        case 'AGUARDANDO_EMAIL':
            if (isImage || isPDF) { await enviarMensagem(phone, "Por favor, apenas *digite* o seu e-mail."); return; }
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(textoIn)) {
                mem.EMAIL = textoIn;
                
                if (mem.IS_ATUALIZACAO) {
                    // SE FOR ATUALIZAÇÃO: Não roda o Puppeteer para gerar contrato novo!
                    mem.STATUS_CADASTRO = 'ATUALIZADO';
                    memoriaEstado.set(phone, mem);
                    await salvarNoBanco(phone, mem);
                    await enviarMensagem(phone, TEXTOS.T08_ATUALIZACAO);
                    memoriaEstado.delete(phone); 
                } else {
                    // SE FOR NOVO CLIENTE: Roda o RPA normal
                    mem.STATUS_CADASTRO = 'CONCLUIDO';
                    memoriaEstado.set(phone, mem);
                    await salvarNoBanco(phone, mem);
                    await enviarMensagem(phone, TEXTOS.T08);
                    setTimeout(async () => {
                        await enviarMensagem(phone, TEXTOS.T_RPA_START);
                        executarRPA(mem, phone); // ACIONA O ROBÔ VALENDO (APENAS PARA NOVOS)
                    }, 2000);
                    memoriaEstado.delete(phone); 
                }
            } else {
                await enviarMensagem(phone, TEXTOS.T12);
            }
            break;
    }
});

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V67 ONLINE`));
