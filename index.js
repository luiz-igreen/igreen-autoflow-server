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

// URLs e Credenciais do Portal iGreen
const IGREEN_LINK_PUBLICO = process.env.IGREEN_LINK || "https://green.igreenenergy.com.br/?id=76049&sendcontract=true";
const IGREEN_DASHBOARD_URL = process.env.IGREEN_DASHBOARD_URL || "https://painel.igreenenergy.com.br";
const IGREEN_USER = process.env.IGREEN_USER || "";
const IGREEN_PASS = process.env.IGREEN_PASS || "";

const APP_ID = 'igreen-autoflow-v4';

try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig && admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    console.log("✅ Banco de Dados Cloud ligado!");
  }
} catch (e) { console.error("Erro DB:", e.message); }

const memoriaEstado = new Map();

// Textos Oficiais
const TEXTOS = {
    T01: "Seja muito bem-vindo(a) ao Atendimento VIP da iGreen Energy! 🌿 Para prepararmos o seu desconto, por favor, me envie uma foto bem nítida (ou PDF) da sua conta de luz mais recente.",
    T02: "Recebemos a sua fatura! Extraindo os seus dados de consumo. Um momento...",
    T04: "Fatura validada! ✅ Para finalizarmos a documentação antifraude, envie uma foto nítida apenas da FRENTE do seu RG ou CNH.",
    T05: "Frente guardada. Agora, envie a foto do VERSO do documento.",
    T06: "Excelente! Os documentos estão sendo encriptados.",
    T07: "Para podermos registrar o seu cadastro, digite o seu melhor e-mail:",
    T08: "Tudo pronto! 🎉 A nossa inteligência entregou toda a sua documentação na base da iGreen Energy. Eles enviarão o link oficial para assinatura em breve! 🌿",
    T08_ATUALIZACAO: "Tudo pronto! 🎉 A sua nova fatura foi enviada com sucesso. A iGreen Energy irá regularizar o seu desconto! 🌿",
    T_ATUALIZAR: "Olá! Vamos atualizar a sua fatura. Envie-me apenas a foto da sua NOVA FATURA de energia. *(Não precisamos dos documentos de identidade novamente).* 🌿",
    T_ATUALIZAR_EMAIL: "Fatura validada! ✅ Para localizarmos o seu cadastro, digite o seu e-mail:",
    
    // TEXTOS MÓDULO DEVOLUTIVA ATUALIZADOS
    T_DEVOLUTIVA_START: "🛠️ *Módulo de Resolução de Pendências (Devolutiva)* ativado. Para o Robô localizar o cliente, digite o *Nome, ID ou CPF* do cliente na iGreen:",
    T_DEVOLUTIVA_DOC: "Alvo validado! 🎯 Agora, por favor, *envie a foto ou PDF do documento solicitado pela iGreen* (ex: Comprovante de Pagamento, RG da testemunha, etc):",
    T_DEVOLUTIVA_FIM: "📂 Documento recebido! O Robô RPA está acessando o Painel do Licenciado para pesquisar o cliente e anexar a devolutiva...",
    
    T11: "Aviso: A imagem não pôde ser lida. Reenvie com mais foco.",
    T12: "O e-mail parece inválido. Digite novamente.",
    T_RPA_START: "🤖 *Sistema*: Iniciando injeção no portal iGreen..."
};

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================
async function extrairDadosFatura(fileUrl, isPdf) {
    if (!GEMINI_API_KEY) return null;
    try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const base64Data = Buffer.from(response.data, 'binary').toString('base64');
        const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';
        const prompt = `Extraia da fatura e retorne apenas um JSON válido com: "NOME_CLIENTE", "CEP", "MEDIA_CONSUMO" (int), "UC".`;
        const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64Data } }] }], generationConfig: { responseMimeType: "application/json" } };
        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`, payload);
        return JSON.parse(geminiRes.data.candidates[0].content.parts[0].text);
    } catch (error) { return null; }
}

async function baixarParaTemp(url, prefix) {
    if(!url) return null;
    try {
        const filepath = path.join(os.tmpdir(), prefix + '_' + Date.now() + (url.includes('.pdf') ? '.pdf' : '.jpg'));
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        fs.writeFileSync(filepath, response.data);
        return filepath;
    } catch(e) { return null; }
}

function criarImagemFantasma(prefix) {
    const filepath = path.join(os.tmpdir(), prefix + '_isento_' + Date.now() + '.jpg');
    const blankJpg = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    fs.writeFileSync(filepath, Buffer.from(blankJpg, 'base64'));
    return filepath;
}

async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numLimpo, message: String(message) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }); } catch (e) {}
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
// MOTOR RPA 1: CADASTROS NOVOS (Portal Público)
// ==========================================
async function executarRPANovoCadastro(dados, phone) {
    console.log(`🚀 [RPA NOVO] Iniciando Entrega de Dados para: ${dados.NOME_CLIENTE}`);
    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(IGREEN_LINK_PUBLICO, { waitUntil: 'networkidle2', timeout: 60000 });

        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('a, button, div')).find(b => b.textContent && b.textContent.toLowerCase().includes('começar'));
            if(btn) btn.click();
        });
        await page.waitForTimeout(4000); 

        const preencher = async (dica, valor) => {
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

        await preencher('00000-000', dados.CEP);
        await preencher('Nome completo', dados.NOME_CLIENTE);
        await preencher('E-mail', dados.EMAIL);
        await preencher('Ex: 250', dados.MEDIA_CONSUMO);
        await preencher('Localizado na sua conta', dados.UC);
        if(dados.CPF) await preencher('CPF', dados.CPF);

        const pathFatura = await baixarParaTemp(dados.LINK_FATURA, 'fatura');
        const pathFrente = dados.LINK_DOC_FRENTE ? await baixarParaTemp(dados.LINK_DOC_FRENTE, 'frente') : criarImagemFantasma('frente');
        const pathVerso = dados.LINK_DOC_VERSO ? await baixarParaTemp(dados.LINK_DOC_VERSO, 'verso') : criarImagemFantasma('verso');

        const fileInputs = await page.$$('input[type="file"]');
        if(fileInputs[0] && pathFatura) await fileInputs[0].uploadFile(pathFatura);
        if(fileInputs[1] && pathFrente) await fileInputs[1].uploadFile(pathFrente);
        if(fileInputs[2] && pathVerso) await fileInputs[2].uploadFile(pathVerso);
        await page.waitForTimeout(2000);

        await page.evaluate(() => {
            const btnFinal = Array.from(document.querySelectorAll('button, a')).find(b => b.textContent && (b.textContent.toLowerCase().includes('finalizar') || b.textContent.toLowerCase().includes('enviar') || b.textContent.toLowerCase().includes('concluir')));
            if (btnFinal) btnFinal.click();
        });

        await page.waitForTimeout(5000); 
        await enviarMensagem(phone, `✅ *DADOS ENTREGUES!* O Robô finalizou a injeção no portal da iGreen.`);
        
        if(pathFatura) fs.unlinkSync(pathFatura);
        if(pathFrente) fs.unlinkSync(pathFrente);
        if(pathVerso) fs.unlinkSync(pathVerso);
        await browser.close();
        return true;
    } catch (error) { await browser.close(); return false; }
}

// ==========================================
// MOTOR RPA 2: MÓDULO DEVOLUTIVAS (Painel Licenciado)
// ==========================================
async function executarRPADevolutiva(termoBusca, fileUrl, phone) {
    console.log(`🛠️ [RPA DEVOLUTIVA] Acessando Painel para buscar: ${termoBusca}`);
    if(!IGREEN_USER || !IGREEN_PASS) {
        await enviarMensagem(phone, "❌ Erro do Sistema: O e-mail e senha do Painel iGreen não foram configurados no Render (IGREEN_USER e IGREEN_PASS).");
        return;
    }

    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        // 1. Acesso e Login
        console.log(`[DEVOLUTIVA] 1. Acessando Dashboard: ${IGREEN_DASHBOARD_URL}`);
        await page.goto(IGREEN_DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        await page.evaluate((u, p) => {
            const inputs = Array.from(document.querySelectorAll('input'));
            const emailInput = inputs.find(i => i.type === 'email' || i.placeholder.toLowerCase().includes('e-mail'));
            const passInput = inputs.find(i => i.type === 'password' || i.placeholder.toLowerCase().includes('senha'));
            if(emailInput) { emailInput.value = u; emailInput.dispatchEvent(new Event('input')); }
            if(passInput) { passInput.value = p; passInput.dispatchEvent(new Event('input')); }
            
            const btnLogin = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent.toLowerCase().includes('login'));
            if(btnLogin) btnLogin.click();
        }, IGREEN_USER, IGREEN_PASS);
        
        await page.waitForTimeout(5000);

        // 2. Navegar até Clientes -> Green
        console.log(`[DEVOLUTIVA] 2. Navegando para Clientes -> Green`);
        await page.evaluate(() => {
            const btnClientes = Array.from(document.querySelectorAll('*')).find(e => e.textContent.trim() === 'Clientes');
            if(btnClientes) btnClientes.click();
        });
        await page.waitForTimeout(2000);
        
        await page.evaluate(() => {
            const btnGreen = Array.from(document.querySelectorAll('*')).find(e => e.textContent.trim() === 'Green' || e.textContent.trim() === 'Mapa de Clientes');
            if(btnGreen) btnGreen.click();
        });
        await page.waitForTimeout(3000);

        // 3. Pesquisar de forma Flexível (Nome, ID ou CPF)
        console.log(`[DEVOLUTIVA] 3. Pesquisando pelo termo: ${termoBusca}`);
        await page.evaluate((busca) => {
            const searchInput = document.querySelector('input[placeholder*="Pesquisa" i], input[type="search"]');
            if(searchInput) {
                searchInput.value = busca;
                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                searchInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, termoBusca);
        await page.waitForTimeout(3000);

        // 4. Clicar nos 3 pontinhos e Status do Contrato -> Devolutivas
        console.log(`[DEVOLUTIVA] 4. Localizando Menu do Cliente (3 pontinhos)`);
        await page.evaluate(() => {
            const dots = Array.from(document.querySelectorAll('button, i, span')).find(e => e.textContent.includes('...') || e.className.includes('dots') || e.className.includes('more'));
            if(dots) dots.click();
        });
        await page.waitForTimeout(1000);

        await page.evaluate(() => {
            const btnStatus = Array.from(document.querySelectorAll('*')).find(e => e.textContent.includes('Status do contrato') || e.textContent.includes('Devolutivas'));
            if(btnStatus) btnStatus.click();
        });
        await page.waitForTimeout(2000);

        // 5. Realizar Ação e Anexar Documento
        console.log(`[DEVOLUTIVA] 5. Upload do Documento no portal...`);
        const pathDoc = await baixarParaTemp(fileUrl, 'devolutiva');
        
        await page.evaluate(() => {
            const btnAcao = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('realizar ação'));
            if(btnAcao && !btnAcao.disabled) btnAcao.click();
        });
        await page.waitForTimeout(2000);

        const fileInputs = await page.$$('input[type="file"]');
        if(fileInputs[0] && pathDoc) await fileInputs[0].uploadFile(pathDoc);
        
        await page.waitForTimeout(2000);
        await page.evaluate(() => {
            const btnSalvar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('enviar') || b.textContent.toLowerCase().includes('salvar') || b.textContent.toLowerCase().includes('concluir'));
            if(btnSalvar) btnSalvar.click();
        });

        await page.waitForTimeout(4000);
        await enviarMensagem(phone, `✅ *DEVOLUTIVA RESOLVIDA!* O Robô entrou no Painel e anexou o documento com sucesso para a busca "${termoBusca}".`);
        
        if(pathDoc) fs.unlinkSync(pathDoc);
        await browser.close();

    } catch (error) {
        console.error("❌ [RPA ERRO DEVOLUTIVA]:", error.message);
        await enviarMensagem(phone, `⚠️ O Robô encontrou um obstáculo na tela da iGreen e não pôde concluir a devolutiva ("${termoBusca}"). Motivo: ${error.message.substring(0,50)}`);
        await browser.close();
    }
}

// ==========================================
// LÓGICA DO WEBHOOK E CHATBOT
// ==========================================
app.post('/webhook/igreen', async (req, res) => {
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

    // COMANDOS DE ENTRADA
    if (['novo', 'nova'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', IS_ATUALIZACAO: false });
        await enviarMensagem(phone, TEXTOS.T01); return;
    }
    if (['atualizar', 'atualizacao', 'atualização'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', IS_ATUALIZACAO: true });
        await enviarMensagem(phone, TEXTOS.T_ATUALIZAR); return;
    }
    if (['devolutiva', 'devolutivas', 'pendencia'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_CPF_DEVOLUTIVA' });
        await enviarMensagem(phone, TEXTOS.T_DEVOLUTIVA_START); return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };
    let status = mem.STATUS_CADASTRO;

    switch (status) {
        // --- FLUXOS NOVO E ATUALIZAR ---
        case 'AGUARDANDO_FATURA':
        case 'NOVO':
            if (!isImage && !isPDF) { await enviarMensagem(phone, "Por favor, envie a foto/PDF da fatura."); return; }
            await enviarMensagem(phone, TEXTOS.T02);
            const dadosExtraidos = await extrairDadosFatura(fileUrl, isPDF);
            
            if (dadosExtraidos) {
                mem = { ...mem, ...dadosExtraidos, LINK_FATURA: fileUrl };
                if (mem.IS_ATUALIZACAO) {
                    mem.STATUS_CADASTRO = 'AGUARDANDO_EMAIL';
                    setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T_ATUALIZAR_EMAIL); }, 3000);
                } else {
                    mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_FRENTE';
                    setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T04); }, 3000);
                }
            } else {
                mem = { ...mem, LINK_FATURA: fileUrl, STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' };
                setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T04); }, 3000);
            }
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            break;

        case 'AGUARDANDO_DOC_FRENTE':
            if (!isImage && !isPDF) { await enviarMensagem(phone, TEXTOS.T11); return; }
            mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_VERSO';
            mem.LINK_DOC_FRENTE = fileUrl;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T05);
            break;

        case 'AGUARDANDO_DOC_VERSO':
            if (!isImage && !isPDF) { await enviarMensagem(phone, TEXTOS.T11); return; }
            mem.STATUS_CADASTRO = 'AGUARDANDO_EMAIL';
            mem.LINK_DOC_VERSO = fileUrl;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarMensagem(phone, TEXTOS.T06);
            setTimeout(async () => { await enviarMensagem(phone, TEXTOS.T07); }, 4000);
            break;

        case 'AGUARDANDO_EMAIL':
            if (isImage || isPDF) { await enviarMensagem(phone, "Apenas digite o e-mail."); return; }
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(textoIn)) {
                mem.EMAIL = textoIn;
                
                if (mem.IS_ATUALIZACAO) {
                    mem.STATUS_CADASTRO = 'ATUALIZADO';
                    await salvarNoBanco(phone, mem);
                    await enviarMensagem(phone, TEXTOS.T08_ATUALIZACAO);
                } else {
                    mem.STATUS_CADASTRO = 'CONCLUIDO';
                    await salvarNoBanco(phone, mem);
                    await enviarMensagem(phone, TEXTOS.T08);
                    setTimeout(async () => {
                        await enviarMensagem(phone, TEXTOS.T_RPA_START);
                        executarRPANovoCadastro(mem, phone); 
                    }, 2000);
                }
                memoriaEstado.delete(phone); 
            } else { await enviarMensagem(phone, TEXTOS.T12); }
            break;

        // --- FLUXO DEVOLUTIVAS (AGORA MAIS FLEXÍVEL) ---
        case 'AGUARDANDO_CPF_DEVOLUTIVA':
            // Agora aceita Nomes, IDs ou CPFs. Basta ter mais de 2 letras/números para ser uma busca válida.
            if (textoIn.length > 2) {
                mem.TERMO_BUSCA = textoIn;
                mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_DEVOLUTIVA';
                memoriaEstado.set(phone, mem);
                await enviarMensagem(phone, TEXTOS.T_DEVOLUTIVA_DOC);
            } else {
                await enviarMensagem(phone, "⚠️ Nome ou ID muito curto. Por favor, digite o Nome Completo, ID ou CPF do cliente:");
            }
            break;

        case 'AGUARDANDO_DOC_DEVOLUTIVA':
            if (!isImage && !isPDF) { await enviarMensagem(phone, "Você precisa me enviar a foto ou PDF do documento para anexar."); return; }
            
            await enviarMensagem(phone, TEXTOS.T_DEVOLUTIVA_FIM);
            
            // Chama o Robô especialista em Devolutivas passando o TERMO DE BUSCA (Nome/ID/CPF)
            executarRPADevolutiva(mem.TERMO_BUSCA, fileUrl, phone);
            
            memoriaEstado.delete(phone); // Limpa a conversa
            break;
    }
});

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V70 ONLINE (Busca Flexível de Devolutivas Ativada)`));
