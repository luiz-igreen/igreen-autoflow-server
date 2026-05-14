import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import fs from 'fs';
import path from 'path';

// Ativar a Capa de Invisibilidade (Anti-Imperva WAF)
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES GERAIS E CHAVES
// ==========================================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

const IGREEN_LOGIN_URL = "https://escritorio.igreenenergy.com.br"; 
const IGREEN_MAPA_URL = "https://escritorio.igreenenergy.com.br/mapa-clientes";
const EQUATORIAL_AL_URL = "https://al.equatorialenergia.com.br/siteantigo";

const IGREEN_USER = process.env.IGREEN_USER;
const IGREEN_PASS = process.env.IGREEN_PASS;
const APP_ID = 'igreen-autoflow-v4';

// 🛡️ CHAVES DO PROXY (IPROYAL)
const PROXY_IP = process.env.PROXY_IP;
const PROXY_PORT = process.env.PROXY_PORT;
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASS = process.env.PROXY_PASS;

try {
    const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
    if (firebaseConfig && admin.apps.length === 0) {
        admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
        console.log("✅ Banco de Dados Cloud ligado!");
    }
} catch (e) { console.error("Erro DB:", e.message); }

const memoriaEstado = new Map();

// ==========================================
// TEXTOS DA OPERAÇÃO (HUMANIZADOS)
// ==========================================
const TEXTOS = {
    T_MENU: "👋 Olá! Bem-vindo ao *Atendimento Inteligente iGreen*. \n\nComo posso ajudar hoje? Escolha uma das opções abaixo enviando apenas o número:\n\n" +
            "1️⃣ *Enviar Fatura* (Tratar Novo Cliente, Devolutivas e Atualizar Banco de Dados)\n" +
            "2️⃣ *Pré-Cadastro* (Salvar dados básicos)\n" +
            "3️⃣ *Resolver Devolutiva (Modo Auto)* (O robô tenta ir à Distribuidora)\n" +
            "4️⃣ *Enviar Documentos* (Anexar RG ou CNH pendentes)\n\n" +
            "_(Dica: Digite *0* a qualquer momento para voltar a este menu)_",
            
    T01: "Opção 1️⃣ selecionada! 🌿 \n*Fluxo Universal de Cadastro e Devolutiva ativado!*\n\nPor favor, envie a foto bem nítida (ou arquivo PDF) da conta de luz do cliente.",
    
    T_RESGATE_START: "Opção 3️⃣ selecionada! ⚡ \nTentaremos o Modo Automático. O robô vai buscar a fatura na Distribuidora.\n\nPor favor, digite apenas o **Nome do Cliente ou ID**.\n\n*(Exemplo: 398172 ou Wellington Silva Nunes)*:",
    T_RESGATE_BUSCANDO: "🔍 Iniciando a verificação em nosso sistema...\n\n1️⃣ Buscando CPF no relatório da iGreen...\n2️⃣ Acessando a Distribuidora...\n3️⃣ Baixando fatura e identificando a UC...\n4️⃣ Retornando à iGreen para anexar...\n\nIsso pode levar alguns segundos, por favor, aguarde...",
    T_RESGATE_SUCESSO: "✅ Sucesso Absoluto! A fatura foi resgatada, processada no nosso Banco de Dados e anexada na aba de Devolutivas da iGreen. A pendência está resolvida!",
    
    T_FALHA_EQUATORIAL_PEDE_FATURA: "⚠️ *Distribuidora Inacessível ou Fatura não encontrada*\n\nNão foi possível baixar a fatura automaticamente na distribuidora.\n\nMas não se preocupe! Para resolvermos isto agora pelo **Fluxo Universal**, por favor, **envie aqui a foto ou o arquivo PDF da fatura do cliente**:",

    T_GUARDAR_START: "Opção 2️⃣ selecionada! 💾 \n*Módulo de Pré-Cadastro* ativado!\nPor favor, envie a foto ou PDF da sua *Fatura de Energia*.",
    T_PEDIR_TELEFONE: "✅ Fatura analisada e salva!\n👤 Titular: ${nome}\n⚡ UC: ${uc}\n\nPara completarmos o seu pré-cadastro, digite o **Número de Telefone (com DDD)** do titular:",
    T_PEDIR_EMAIL: "Ótimo! 📱 Telefone salvo.\n\nAgora, por favor, digite o **melhor E-mail** do titular:",
    T_FIM_PRE_CADASTRO: "Perfeito! 📧 E-mail salvo no seu perfil.\n\n⚠️ *Aviso:* O seu cadastro está 'Pendente de Documentos'. Quando quiser enviar a foto do seu documento (Frente e Verso), escolha a **Opção 4** no menu inicial.",
    
    T_START_OPCAO_4: "Opção 4️⃣ selecionada! 📎\nPara anexarmos o documento no cadastro correto, digite o número da sua **UC ou Conta Contrato** (apenas os números):",
    T_OP4_FALTANDO_TEL: "🔍 Localizei o seu cadastro, mas ainda não temos o seu **Telefone**. Digite-o com DDD para atualizarmos:",
    T_OP4_FALTANDO_MAIL: "Certo! E qual o seu melhor **E-mail**?",
    T_PEDIR_FOTO_DOC_FRENTE: "✅ Cadastro atualizado e pronto! \n\nPor favor, envie agora uma foto legível apenas da **FRENTE** do seu Documento de Identificação (RG ou CNH):",
    T_PEDIR_FOTO_DOC_VERSO: "✅ Frente recebida!\n\nAgora, envie a foto do **VERSO** do mesmo documento:",
    T_DOCS_RECEBIDOS: "✅ Documentos recebidos com sucesso! \nAs imagens foram anexadas ao seu perfil com segurança. Muito obrigado! 🙏"
};

const CHROME_ARGS = [
    "--no-sandbox", 
    "--disable-setuid-sandbox", 
    "--disable-dev-shm-usage", 
    "--disable-gpu", 
    "--no-zygote", 
    "--disable-blink-features=AutomationControlled",
    "--ignore-certificate-errors"
];

// ==========================================
// FUNÇÕES AUXILIARES E IA
// ==========================================
async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { 
        await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
        { phone: numLimpo, message: String(message) }, 
        { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' } }); 
    } catch (e) { console.error(`[Z-API] Erro:`, e.message); }
}

async function buscarNoBanco(docId) {
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            const doc = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(docId).get();
            return doc.exists ? doc.data() : null;
        } catch (e) { return null; }
    }
    return null;
}

function limparDadosVazios(dados) {
    return Object.fromEntries(Object.entries(dados).filter(([_, v]) => v !== "" && v !== "Não extraído" && v !== "0" && v !== null && v !== undefined));
}

async function salvarNoBanco(docId, phone, dadosExtras) {
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            const dadosLimpos = limparDadosVazios(dadosExtras); 
            await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(docId).set(
                { ...dadosLimpos, TELEFONE_REMETENTE: phone, DATA_ULTIMA_ATUALIZACAO: admin.firestore.FieldValue.serverTimestamp() }, 
                { merge: true } 
            );
        } catch (e) { console.error("Erro Firebase:", e.message); }
    }
}

// 🔥 FUNÇÃO DA INTELIGÊNCIA ARTIFICIAL (CORRIGIDA DEFINITIVAMENTE: GEMINI-1.5-FLASH)
async function analisarFaturaGemini(mediaUrl, mimeType) {
    try {
        console.log(`\n[IA GEMINI] 📥 Iniciando download do arquivo na Z-API: ${mediaUrl}`);
        const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
        
        if (!response.data || response.data.length === 0) {
            throw new Error("O ficheiro baixado está vazio.");
        }

        const base64Data = Buffer.from(response.data, 'binary').toString('base64');
        console.log(`[IA GEMINI] ✅ Download concluído com sucesso. Tamanho: ${base64Data.length} bytes.`);
        console.log(`[IA GEMINI] 🧠 Enviando arquivo (${mimeType}) para a nuvem da Google Gemini...`);

        // 🔥 A CORREÇÃO DE MESTRE: Usando o nome técnico correto v1beta/gemini-1.5-flash
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        
        const promptText = `Extraia os dados desta fatura de energia. Chaves necessárias: "NOME_CLIENTE", "CPF", "DATA_NASCIMENTO", "UC", "VENCIMENTO", "VALOR". Se não encontrar alguma, deixe em branco.`;

        // Ativando o Modo JSON Nativo suportado no 1.5-Flash
        const payload = {
            contents: [{ parts: [ { text: promptText }, { inline_data: { mime_type: mimeType === 'application/pdf' ? 'application/pdf' : 'image/jpeg', data: base64Data } } ] }],
            generationConfig: {
                responseMimeType: "application/json"
            }
        };

        const result = await axios.post(geminiUrl, payload, { headers: { 'Content-Type': 'application/json' } });
        
        let textoResposta = result.data.candidates[0].content.parts[0].text;
        
        console.log(`[IA GEMINI] 🎯 Leitura concluída com SUCESSO! Resultado:`, textoResposta);
        return JSON.parse(textoResposta);
        
    } catch (error) {
        console.error("\n❌ ===============================================");
        console.error("❌ [ERRO IA GEMINI] Falha profunda ao analisar fatura:");
        if (error.response) {
            console.error("Status Code Google:", error.response.status);
            console.error("Detalhes do Google:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Mensagem de Erro:", error.message);
        }
        console.error("❌ ===============================================\n");
        throw new Error("Falha ao ler fatura.");
    }
}

// =================================================================================
// 🚀 FLUXO UNIVERSAL DO MESTRE (DB PRIMEIRO -> IGREEN DEPOIS)
// =================================================================================
async function fluxoProcessamentoUniversal(mediaUrl, mimeType, phone, cpfAlvo = null) {
    const localPath = path.join('/tmp', `fatura_universal_${Date.now()}.pdf`);
    let browserIgreen = null;
    
    try {
        console.log(`\n[FLUXO UNIVERSAL] 🔥 Iniciado via WhatsApp para o telemóvel: ${phone}`);
        await enviarMensagem(phone, "📥 *Iniciando Fluxo Universal...*\n\n🤖 1️⃣ Analisando a fatura com Inteligência Artificial para capturar CPF e UC...");
        
        let dadosIA;
        try {
            dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
        } catch (e) {
            await enviarMensagem(phone, "⚠️ A Inteligência Artificial teve dificuldade em ler o arquivo. Certifique-se que a imagem é nítida ou o PDF é válido.");
            return;
        }

        const ucLimpa = dadosIA.UC ? String(dadosIA.UC).replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
        const cpfFatura = dadosIA.CPF ? String(dadosIA.CPF).replace(/\D/g, '') : null;
        const cpfFinal = cpfFatura || cpfAlvo; 

        await enviarMensagem(phone, `🔍 2️⃣ Verificando no nosso Banco de Dados Oficial se a UC *${ucLimpa}* já existe...`);
        const clienteExiste = await buscarNoBanco(ucLimpa);
        
        if (clienteExiste) {
            console.log(`[BANCO DE DADOS] Cliente UC ${ucLimpa} já existe. Executando UPDATE.`);
            await enviarMensagem(phone, `🔄 *Cliente Encontrado no nosso BD!* \nO sistema está a **Atualizar os Dados** do cliente com as informações desta nova fatura...`);
        } else {
            console.log(`[BANCO DE DADOS] Cliente UC ${ucLimpa} novo. Executando INSERT.`);
            await enviarMensagem(phone, `🆕 *Cliente Novo no nosso BD!* \nO sistema está a **Incluir os Dados** no nosso Banco de Dados de forma permanente...`);
        }
        
        await salvarNoBanco(ucLimpa, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "PROCESSADO_UNIVERSAL" });
        await new Promise(r => setTimeout(r, 1500));

        if (!cpfFinal) {
            await enviarMensagem(phone, "⚠️ O CPF não foi identificado na fatura. O arquivo foi salvo no nosso banco com sucesso, mas a injeção na iGreen foi abortada (O sistema da iGreen exige o CPF para anexar).");
            return;
        }

        console.log(`[FLUXO UNIVERSAL] Banco Salvo. Acionando Robô para ir à iGreen (CPF alvo: ${cpfFinal})...`);
        await enviarMensagem(phone, `🚀 3️⃣ Banco atualizado! Baixando o PDF e voando para o portal da iGreen para anexar (CPF Alvo: ${cpfFinal})...`);
        
        const response = await axios({ url: mediaUrl, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(localPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        
        console.log(`[IGREEN] Lançando Puppeteer...`);
        browserIgreen = await puppeteer.launch({ 
            headless: "new", 
            args: CHROME_ARGS,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() 
        });
        const pageIgreen = await browserIgreen.newPage();
        await pageIgreen.setViewport({ width: 4000, height: 1080 });
        
        await pageIgreen.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
        
        await pageIgreen.waitForSelector('input[type="email"]', { timeout: 15000 });
        await pageIgreen.type('input[type="email"]', IGREEN_USER, { delay: 50 });
        await pageIgreen.type('input[type="password"]', IGREEN_PASS, { delay: 50 });
        await pageIgreen.evaluate(() => { const btnEntrar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent.toLowerCase().includes('acessar')); if (btnEntrar) btnEntrar.click(); });
        
        await Promise.race([ pageIgreen.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }), new Promise(resolve => setTimeout(resolve, 10000)) ]);
        try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}

        await pageIgreen.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));
        await pageIgreen.evaluate(() => { document.body.style.zoom = "0.4"; });
        
        let searchInput = await pageIgreen.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 });
        await searchInput.click({ clickCount: 3 });
        await pageIgreen.keyboard.press('Backspace');
        await searchInput.type(cpfFinal, { delay: 100 }); 
        await pageIgreen.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 4000));

        await pageIgreen.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 9999); });
        await new Promise(r => setTimeout(r, 1500));
        
        const clicouPontinhos = await pageIgreen.evaluate((cpfBusca) => { 
            const linhas = Array.from(document.querySelectorAll('tr, [role="row"], div[class*="MuiDataGrid-row"]')); 
            const linhaExata = linhas.find(row => row.textContent.replace(/\D/g, '').includes(cpfBusca)); 
            if(linhaExata) {
                const btnTresPontinhos = Array.from(linhaExata.querySelectorAll('button, div')).find(el => el.textContent.trim() === '...'); 
                if(btnTresPontinhos) { btnTresPontinhos.click(); return true; }
            }
            return false;
        }, cpfFinal);

        if (!clicouPontinhos) {
             throw new Error("CLIENTE_NAO_ENCONTRADO_MAPA");
        }
        
        await new Promise(r => setTimeout(r, 2000));
        await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, li, div')).find(el => el.textContent.includes('Devolutivas')); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 3000));

        for (let clique = 0; clique < 3; clique++) {
            await pageIgreen.evaluate(() => { 
                const botoesAcao = Array.from(document.querySelectorAll('button, span, a, div')).filter(el => el.textContent.trim() === 'Realizar ação' || el.textContent.includes('Realizar ação'));
                const btn = botoesAcao.filter(b => b.offsetParent !== null).pop() || botoesAcao[botoesAcao.length - 1]; 
                if(btn) { btn.scrollIntoView({behavior: 'smooth', block: 'center'}); btn.click(); }
            });
            await new Promise(r => setTimeout(r, 3000));
        }

        const inputUploads = await pageIgreen.$$('input[type="file"]');
        if (inputUploads.length > 0) {
            for (let input of inputUploads) {
                try {
                    await input.uploadFile(localPath);
                    await pageIgreen.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);
                } catch(e){}
            }
        } else {
             throw new Error("O formulário de anexo da iGreen está bloqueado ou invisível.");
        }
        await new Promise(r => setTimeout(r, 3000));

        await pageIgreen.evaluate(() => { 
            const btnSalvar = Array.from(document.querySelectorAll('button')).find(el => el.textContent.toUpperCase().includes('ENVIAR') || el.textContent.toUpperCase().includes('SALVAR') || el.textContent.toUpperCase().includes('CONCLUIR')); 
            if (btnSalvar) btnSalvar.click(); 
        });
        await new Promise(r => setTimeout(r, 5000));

        console.log(`[FLUXO UNIVERSAL] 🏆 Sucesso Absoluto! Fatura salva na iGreen.`);
        await enviarMensagem(phone, "🎉 *Fim do Processo Universal!*\n\n1️⃣ Banco de Dados Sincronizado 💾\n2️⃣ Fatura Anexada na iGreen 🌿\n\nA operação foi um Sucesso Absoluto!");
        
    } catch (e) {
        if (e.message === "CLIENTE_NAO_ENCONTRADO_MAPA") {
            await enviarMensagem(phone, "✅ A fatura foi guardada no *Nosso Banco de Dados*!\n\n⚠️ Contudo, o robô não anexou na iGreen porque este cliente ainda não aparece no seu Mapa de Clientes do escritório virtual.");
        } else {
            console.error(`\n❌ [ERRO FLUXO UNIVERSAL]: ${e.message}\n`);
            await enviarMensagem(phone, "⚠️ A fatura foi salva no nosso Banco, mas ocorreu um erro de conexão ao tentar anexar na iGreen. Tente novamente mais tarde.");
        }
    } finally {
        if (browserIgreen) await browserIgreen.close().catch(()=>{});
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath).catch(()=>{});
    }
}

// ==========================================
// MÓDULO 2: EXTRATOR RPA TOTAL (EQUATORIAL)
// ==========================================
async function fluxoResgateDevolutiva(termoBuscaIgreen, phone, cpfBanco = null, nascBanco = null, isAutomated = false) {
    let browserIgreen = null;
    let browserEquatorial = null;
    const caminhoFaturaLocal = path.join('/tmp', `fatura_${Date.now()}.pdf`);
    let cpf = cpfBanco;
    let nascimento = nascBanco;
    let ucExtraidaEquatorial = null; 
    let pdfCapturado = false;

    try {
        console.log(`[RPA] 🚀 Arrancando MOTOR 1 (iGreen - Sem Proxy)...`);
        browserIgreen = await puppeteer.launch({ 
            headless: "new", 
            args: CHROME_ARGS,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() 
        });
        
        const pageIgreen = await browserIgreen.newPage();
        await pageIgreen.setViewport({ width: 4000, height: 1080 }); 

        if (!cpf || !nascimento) {
            console.log(`[RPA] ETAPA 1: Buscando dados de ${termoBuscaIgreen} na iGreen...`);
            await pageIgreen.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
            
            await pageIgreen.waitForSelector('input[type="email"]');
            await pageIgreen.type('input[type="email"]', IGREEN_USER, { delay: 50 });
            await pageIgreen.type('input[type="password"]', IGREEN_PASS, { delay: 50 });
            
            await pageIgreen.evaluate(() => {
                const btnEntrar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent
