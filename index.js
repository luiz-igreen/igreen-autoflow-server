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
            "1️⃣ *Novo Cadastro* (Analisar fatura e preparar o seu desconto)\n" +
            "2️⃣ *Pré-Cadastro* (Salvar dados da fatura)\n" +
            "3️⃣ *Resolver Devolutiva* (Automação completa Equatorial/iGreen)\n" +
            "4️⃣ *Enviar Documentos* (Anexar RG ou CNH pendentes)\n\n" +
            "_(Dica: Digite *0* a qualquer momento para voltar a este menu)_",
            
    T01: "Opção 1️⃣ selecionada! 🌿 \nPara prepararmos o seu desconto e o seu contrato, por favor, envie uma foto bem nítida (ou arquivo PDF) da sua conta de luz mais recente.",
    T02: "Recebemos o seu documento! 📄 A nossa assistente virtual está a analisar as informações neste exato momento. Só um instante...",
    
    T_RESGATE_START: "Opção 3️⃣ selecionada! ⚡ \nPara resolvermos a devolutiva, a nossa equipe vai buscar os seus dados no escritório, baixar a fatura atualizada na Distribuidora e anexar.\n\nPor favor, digite apenas o **Nome do Cliente ou ID**.\n\n*(Exemplo: 398172 ou Wellington Silva Nunes)*:",
    T_RESGATE_BUSCANDO: "🔍 Iniciando a verificação em nosso sistema...\n\n1️⃣ Buscando CPF no relatório da iGreen...\n2️⃣ Acessando a Distribuidora...\n3️⃣ Baixando fatura e identificando a UC...\n4️⃣ Retornando à iGreen para anexar...\n\nIsso pode levar alguns segundos, por favor, aguarde...",
    T_RESGATE_SUCESSO: "✅ Sucesso Absoluto! A fatura foi resgatada, processada no nosso Banco de Dados e anexada na aba de Devolutivas da iGreen. A pendência está resolvida!",
    T_RESGATE_FAIL: "⚠️ Ocorreu um erro genérico no processo. Tente novamente.",
    
    // 💡 PLANO B (FALLBACK DA DEVOLUTIVA)
    T_FALHA_EQUATORIAL_PEDE_FATURA: "⚠️ *Distribuidora Inacessível*\n\nNão foi possível baixar a fatura automaticamente no site da distribuidora (bloqueio ou site indisponível).\n\nMas não se preocupe! Para resolvermos a devolutiva agora mesmo, por favor, **envie aqui a foto ou o arquivo PDF da fatura do cliente**:",

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

async function analisarFaturaGemini(mediaUrl, mimeType) {
    try {
        console.log("[IA] Baixando documento para análise no Gemini...");
        const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
        const base64Data = Buffer.from(response.data, 'binary').toString('base64');

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const promptText = `Analise esta fatura de energia. Extraia os dados em formato JSON exato. Chaves necessárias: "NOME_CLIENTE", "CPF", "DATA_NASCIMENTO", "UC", "VENCIMENTO", "VALOR". Retorne APENAS o JSON, sem marcações ou blocos de código markdown.`;

        const payload = {
            contents: [{
                parts: [
                    { text: promptText },
                    { inline_data: { mime_type: mimeType === 'application/pdf' ? 'application/pdf' : 'image/jpeg', data: base64Data } }
                ]
            }]
        };

        const result = await axios.post(geminiUrl, payload, { headers: { 'Content-Type': 'application/json' } });
        let textoResposta = result.data.candidates[0].content.parts[0].text;
        
        textoResposta = textoResposta.replace(/```json/g, '').replace(/```/g, '').trim();
        console.log("[IA] Leitura concluída com sucesso!");
        return JSON.parse(textoResposta);
    } catch (error) {
        console.error("[IA] Erro na análise Gemini:", error.response?.data || error.message);
        throw new Error("Falha ao ler fatura.");
    }
}

// =================================================================================
// 🚀 INJEÇÃO MANUAL (O PLANO B) - Vai à iGreen anexar a fatura enviada pelo Whatsapp
// =================================================================================
async function injetarFaturaManualIgreen(cpf, mediaUrl, phone) {
    let browserIgreen = null;
    const localPath = path.join('/tmp', `fatura_manual_${Date.now()}.pdf`);
    
    try {
        console.log(`\n[PLANO B] ⚡ Iniciando injeção manual para o CPF/CNPJ alvo: ${cpf}`);
        await enviarMensagem(phone, "📥 Baixando e analisando o seu arquivo (Atualizando Banco de Dados e Fila iGreen)...");
        
        // 1. Fazer o download do PDF/Imagem enviado
        console.log(`[PLANO B] Baixando arquivo do WhatsApp para /tmp...`);
        const response = await axios({ url: mediaUrl, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(localPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        
        await enviarMensagem(phone, "⚙️ Arquivo preparado! Iniciando a injeção silenciosa no escritório da iGreen...");

        // 2. Ligar o Motor da iGreen
        console.log(`[PLANO B] Lançando Puppeteer (iGreen)...`);
        browserIgreen = await puppeteer.launch({ 
            headless: "new", 
            args: CHROME_ARGS,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() 
        });
        const pageIgreen = await browserIgreen.newPage();
        await pageIgreen.setViewport({ width: 4000, height: 1080 });
        
        // Login iGreen
        console.log(`[PLANO B] Acessando URL de Login...`);
        await pageIgreen.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
        
        console.log(`[PLANO B] Aguardando inputs de login...`);
        await pageIgreen.waitForSelector('input[type="email"]', { timeout: 15000 });
        
        console.log(`[PLANO B] Inserindo credenciais da iGreen...`);
        await pageIgreen.type('input[type="email"]', IGREEN_USER, { delay: 50 });
        await pageIgreen.type('input[type="password"]', IGREEN_PASS, { delay: 50 });
        
        await pageIgreen.evaluate(() => { const btnEntrar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent.toLowerCase().includes('acessar')); if (btnEntrar) btnEntrar.click(); });
        
        console.log(`[PLANO B] Aguardando redirecionamento após login...`);
        await Promise.race([ pageIgreen.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }), new Promise(resolve => setTimeout(resolve, 10000)) ]);
        
        try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}

        // Ir para o Mapa e Procurar o CPF
        console.log(`[PLANO B] Navegando para o Mapa de Clientes...`);
        await pageIgreen.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));
        await pageIgreen.evaluate(() => { document.body.style.zoom = "0.4"; });
        
        console.log(`[PLANO B] Buscando o cliente na barra de pesquisa...`);
        let searchInput = await pageIgreen.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 });
        await searchInput.click({ clickCount: 3 });
        await pageIgreen.keyboard.press('Backspace');
        await searchInput.type(cpf, { delay: 100 }); 
        await pageIgreen.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 4000));

        await pageIgreen.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 9999); });
        await new Promise(r => setTimeout(r, 1500));
        
        console.log(`[PLANO B] Procurando a linha do cliente e clicando nos 3 pontinhos...`);
        const clicouPontinhos = await pageIgreen.evaluate((cpfBusca) => { 
            const linhas = Array.from(document.querySelectorAll('tr, [role="row"], div[class*="MuiDataGrid-row"]')); 
            const linhaExata = linhas.find(row => row.textContent.replace(/\D/g, '').includes(cpfBusca)); 
            if(linhaExata) {
                const btnTresPontinhos = Array.from(linhaExata.querySelectorAll('button, div')).find(el => el.textContent.trim() === '...'); 
                if(btnTresPontinhos) { btnTresPontinhos.click(); return true; }
            }
            return false;
        }, cpf);

        if (!clicouPontinhos) {
             throw new Error("Não foi possível encontrar a linha do cliente na tabela após a pesquisa.");
        }
        
        await new Promise(r => setTimeout(r, 2000));
        console.log(`[PLANO B] Clicando no menu 'Devolutivas'...`);
        await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, li, div')).find(el => el.textContent.includes('Devolutivas')); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 3000));

        console.log(`[PLANO B] Lidando com os popups e alertas da Devolutiva...`);
        for (let clique = 0; clique < 3; clique++) {
            await pageIgreen.evaluate(() => { 
                const botoesAcao = Array.from(document.querySelectorAll('button, span, a, div')).filter(el => el.textContent.trim() === 'Realizar ação' || el.textContent.includes('Realizar ação'));
                const btn = botoesAcao.filter(b => b.offsetParent !== null).pop() || botoesAcao[botoesAcao.length - 1]; 
                if(btn) { btn.scrollIntoView({behavior: 'smooth', block: 'center'}); btn.click(); }
            });
            await new Promise(r => setTimeout(r, 3000));
        }

        // Injeção do PDF
        console.log(`[PLANO B] Injetando arquivo local na página da iGreen...`);
        const inputUploads = await pageIgreen.$$('input[type="file"]');
        if (inputUploads.length > 0) {
            for (let input of inputUploads) {
                try {
                    await input.uploadFile(localPath);
                    await pageIgreen.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);
                } catch(e){}
            }
            console.log(`[PLANO B] Arquivo injetado com sucesso nos inputs invisíveis!`);
        } else {
             throw new Error("O formulário de anexo da iGreen está bloqueado ou invisível.");
        }
        await new Promise(r => setTimeout(r, 3000));

        // Salvar Devolutiva
        console.log(`[PLANO B] Clicando em Salvar/Enviar para finalizar...`);
        await pageIgreen.evaluate(() => { 
            const btnSalvar = Array.from(document.querySelectorAll('button')).find(el => el.textContent.toUpperCase().includes('ENVIAR') || el.textContent.toUpperCase().includes('SALVAR') || el.textContent.toUpperCase().includes('CONCLUIR')); 
            if (btnSalvar) btnSalvar.click(); 
        });
        await new Promise(r => setTimeout(r, 5000));

        console.log(`[PLANO B] 🏆 Operação manual concluída com SUCESSO!`);
        await enviarMensagem(phone, TEXTOS.T_RESGATE_SUCESSO);
        
    } catch (e) {
        console.error(`\n❌ [PLANO B - ERRO FATAL]: ${e.message}\n`);
        await enviarMensagem(phone, "⚠️ Erro ao tentar injetar a fatura. Motivo: O portal da iGreen demorou a responder ou o cliente não foi encontrado no mapa.");
    } finally {
        if (browserIgreen) await browserIgreen.close().catch(()=>{});
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath).catch(()=>{});
    }
}


// ==========================================
// MÓDULO 2: EXTRATOR RPA TOTAL (ARQUITETURA DE DOIS MOTORES)
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
        // ==============================================================
        // MOTOR 1: IGREEN (Conexão Direta, Nativa e Rápida)
        // ==============================================================
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
                const botoes = Array.from(document.querySelectorAll('button'));
                const btnEntrar = botoes.find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent.toLowerCase().includes('acessar') || b.textContent.toLowerCase().includes('login'));
                if (btnEntrar) btnEntrar.click();
            });
            await pageIgreen.keyboard.press('Enter');
            
            await Promise.race([
                pageIgreen.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
                new Promise(resolve => setTimeout(resolve, 10000))
            ]);

            if (pageIgreen.url().includes('login')) throw new Error("ERRO_LOGIN_IGREEN");

            try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}

            await pageIgreen.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 5000));

            await pageIgreen.evaluate(() => { document.body.style.zoom = "0.4"; });
            await new Promise(r => setTimeout(r, 1000));

            let searchInput;
            try {
                searchInput = await pageIgreen.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 });
            } catch (erroSeletor) { throw new Error("LINHA_CLIENTE_NAO_ENCONTRADA"); }

            await searchInput.click();
            await new Promise(r => setTimeout(r, 500));
            await searchInput.click({ clickCount: 3 });
            await pageIgreen.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 500));
            await searchInput.type(termoBuscaIgreen, { delay: 100 }); 
            await new Promise(r => setTimeout(r, 500));
            await pageIgreen.keyboard.press('Enter');
            
            try {
                await pageIgreen.waitForFunction((busca) => document.body.innerText.toLowerCase().includes(busca.toLowerCase()), { timeout: 12000 }, termoBuscaIgreen);
            } catch (e) {}
            await new Promise(r => setTimeout(r, 2000));

            await pageIgreen.evaluate(() => {
                const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller');
                scrollers.forEach(s => s.scrollLeft = 9999);
            });
            await new Promise(r => setTimeout(r, 2000)); 

            const dadosExtraidos = await pageIgreen.evaluate((busca) => {
                const buscaLimpa = busca.toLowerCase().trim();
                const possiveisLinhas = Array.from(document.querySelectorAll('tr, [role="row"], .MuiDataGrid-row'));
                const linhasComDados = possiveisLinhas.filter(l => l.textContent.trim().length > 15 && !l.querySelector('th') && !l.getAttribute('role')?.includes('columnheader'));
                const linhaExata = linhasComDados.find(linha => linha.textContent.toLowerCase().includes(buscaLimpa));
                
                if (!linhaExata) return { falhouBusca: true };

                let colunas = Array.from(linhaExata.querySelectorAll('td, [role="cell"], .MuiDataGrid-cell'));
                if (colunas.length === 0) colunas = Array.from(linhaExata.children);
                const textoLinha = colunas.map(c => c.textContent.trim()).join('   ');
                
                let cpfExt = null; let nascExt = null;

                const cpfMatch = textoLinha.match(/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
                if (cpfMatch) cpfExt = cpfMatch[0];

                const todasDatas = textoLinha.match(/\d{2}\/\d{2}\/\d{4}/g);
                if (todasDatas && todasDatas.length > 0) {
                    let menorAno = 9999;
                    for (let d of todasDatas) {
                        let ano = parseInt(d.split('/')[2], 10);
                        if (ano < menorAno) { menorAno = ano; nascExt = d; }
                    }
                    if (menorAno > 2015) nascExt = null; 
                }

                if (cpfExt) cpfExt = cpfExt.replace(/\D/g, '');
                return { cpfExt, nascExt };
            }, termoBuscaIgreen);

            if (dadosExtraidos && dadosExtraidos.falhouBusca) throw new Error("LINHA_CLIENTE_NAO_ENCONTRADA");
            if (!dadosExtraidos || !dadosExtraidos.cpfExt || !dadosExtraidos.nascExt) throw new Error("FALTAM_DADOS_ESSENCIAIS");

            cpf = dadosExtraidos.cpfExt;
            nascimento = dadosExtraidos.nascExt;

            console.log(`\n======================================================`);
            console.log(`[🟢 SUCESSO - DADOS EXTRAÍDOS DO MAPA DA IGREEN]`);
            console.log(`👤 CPF Identificado:      ${cpf}`);
            console.log(`🎂 Data Nasc. Identificada: ${nascimento}`);
            console.log(`======================================================\n`);
        }

        // ==============================================================
        // MOTOR 2: EQUATORIAL (COM PROXY-CHAIN OBRIGATÓRIO)
        // ==============================================================
        console.log(`[RPA] 👻 Preparando MOTOR 2 (Equatorial)...`);

        for (let tentativa = 1; tentativa <= 3; tentativa++) {
            console.log(`\n[RPA] ---> Iniciando Salto para Equatorial (Tentativa ${tentativa}/3) <---`);
            let proxyUrlForPuppeteer = null;

            try {
                let puppeteerArgsEq = [...CHROME_ARGS];
                
                if (PROXY_IP && PROXY_PORT && PROXY_USER && PROXY_PASS) {
                    const rawProxyUrl = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_IP}:${PROXY_PORT}`;
                    proxyUrlForPuppeteer = await anonymizeProxy(rawProxyUrl);
                    puppeteerArgsEq.push(`--proxy-server=${proxyUrlForPuppeteer}`);
                } 

                browserEquatorial = await puppeteer.launch({ 
                    headless: "new", 
                    args: puppeteerArgsEq,
                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
                    defaultViewport: { width: 1366, height: 768 } 
                });
                
                const pageEq = await browserEquatorial.newPage();
                await pageEq.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' });

                const clientEq = await pageEq.target().createCDPSession();
                await clientEq.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' });

                const escutarPDF = async (response) => {
                    try {
                        const contentType = response.headers()['content-type'];
                        const contentDisposition = response.headers()['content-disposition'];
                        if (response.status() === 200 && ((contentType && contentType.includes('application/pdf')) || 
                            (contentDisposition && contentDisposition.includes('.pdf')))) {
                            const buffer = await response.buffer();
                            fs.writeFileSync(caminhoFaturaLocal, buffer);
                        }
                    } catch(err) {}
                };

                pageEq.on('response', escutarPDF);
                browserEquatorial.on('targetcreated', async (target) => {
                    if (target.type() === 'page') { try { const novaAba = await target.page(); novaAba.on('response', escutarPDF); } catch (e) {} }
                });

                await pageEq.goto(EQUATORIAL_AL_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
                await new Promise(r => setTimeout(r, 5000)); 

                const bodyTextInicio = await pageEq.evaluate(() => document.body.innerText.toLowerCase());
                if (bodyTextInicio.includes("access denied") || bodyTextInicio.includes("error 16") || bodyTextInicio.includes("imperva")) {
                    throw new Error("IMPERVA_BLOCK");
                }

                await pageEq.evaluate(() => {
                    const btnSair = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase().includes('SAIR') || el.textContent.toUpperCase().includes('X SAIR'));
                    if (btnSair) btnSair.click(); 
                });
                await new Promise(r => setTimeout(r, 4000)); 

                await pageEq.evaluate(() => {
                    const check = document.querySelector('input[type="checkbox"]'); if(check) check.click();
                    const btnEnviar = Array.from(document.querySelectorAll('button, div, span')).find(el => el.textContent.toUpperCase().includes('ENVIAR')); if(btnEnviar) btnEnviar.click();
                    const btnFechar = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase() === 'FECHAR' || el.textContent.toUpperCase() === 'X'); if(btnFechar) btnFechar.click();
                });
                await new Promise(r => setTimeout(r, 2000));
                
                let encontrouCpf = await pageEq.evaluate(() => {
                    const inputs = Array.from(document.querySelectorAll('input'));
                    let cpfField = inputs.find(i => (i.placeholder && i.placeholder.toLowerCase().includes('cpf')) || (i.id && i.id.toLowerCase().includes('cpf')));
                    if (cpfField) { cpfField.focus(); cpfField.click(); return true; }
                    return false;
                });

                if (encontrouCpf) {
                    await pageEq.keyboard.type(cpf, { delay: 100 }); 
                    await new Promise(r => setTimeout(r, 1000));
                    await pageEq.evaluate(() => {
                        const btnEntrar = Array.from(document.querySelectorAll('button, a, div')).find(b => b.textContent.trim().toUpperCase() === 'ENTRAR' || b.textContent.trim().toUpperCase() === 'CONTINUAR');
                        if (btnEntrar) btnEntrar.click();
                    });
                }
                
                await new Promise(r => setTimeout(r, 4000));

                let encontrouNasc = await pageEq.evaluate(() => {
                    const inputs = Array.from(document.querySelectorAll('input'));
                    let nascField = inputs.find(i => (i.placeholder && i.placeholder.toLowerCase().includes('nascimento')) || (i.id && i.id.toLowerCase().includes('nasc')));
                    if (nascField && nascField.offsetParent !== null) { nascField.focus(); nascField.click(); return true; }
                    return false;
                });

                if (encontrouNasc) {
                    await pageEq.keyboard.type(nascimento, { delay: 100 });
                    await new Promise(r => setTimeout(r, 1000));
                    await pageEq.evaluate(() => {
                        const btnEntrar = Array.from(document.querySelectorAll('button, a, div')).find(b => b.textContent.trim().toUpperCase() === 'ENTRAR' || b.textContent.trim().toUpperCase() === 'CONTINUAR' || b.textContent.trim().toUpperCase() === 'ACESSAR');
                        if (btnEntrar) btnEntrar.click();
                    });
                }

                await new Promise(r => setTimeout(r, 15000));

                await pageEq.evaluate(() => {
                    const btnFechar = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase() === 'FECHAR' || el.textContent.toUpperCase() === 'X');
                    if(btnFechar) btnFechar.click(); 
                });
                await new Promise(r => setTimeout(r, 1000));

                await pageEq.evaluate(() => {
                    const elementos = Array.from(document.querySelectorAll('a, button, span, div, h2, h3, p'));
                    const linkEq = elementos.find(el => {
                        const txt = el.textContent.trim().toUpperCase();
                        return (txt === 'EQUATORIAL ALAGOAS' || txt === 'ALAGOAS' || txt === 'ACESSAR' || txt === 'IR PARA O PORTAL' || txt.includes('EQUATORIAL')) && el.offsetParent !== null && txt.length < 35;
                    });
                    if (linkEq) { linkEq.click(); if(linkEq.parentElement) linkEq.parentElement.click(); }
                });
                await new Promise(r => setTimeout(r, 5000));

                const ucIdentificada = await pageEq.evaluate(() => {
                    const elementos = Array.from(document.querySelectorAll('span, div, p, a, li, option, td, h3, h4, b, strong, select'));
                    const elemUc = elementos.find(el => {
                        const txt = el.textContent.trim();
                        if (txt.includes('/') || txt.includes('-') || txt.includes('.')) return false;
                        const soNumeros = txt.replace(/\D/g, '');
                        return soNumeros.length >= 8 && soNumeros.length <= 15 && txt === soNumeros;
                    });
                    if (elemUc) { elemUc.click(); if(elemUc.parentElement) elemUc.parentElement.click(); return elemUc.textContent.trim(); }
                    return null;
                });

                if (ucIdentificada) {
                    ucExtraidaEquatorial = ucIdentificada;
                    await salvarNoBanco(cpf, phone, { UC_ATUALIZADA_EQUATORIAL: ucIdentificada, UC: ucIdentificada });
                }
                
                await new Promise(r => setTimeout(r, 5000));

                let faturasNaTela = await pageEq.evaluate(() => {
                    const faturas = Array.from(document.querySelectorAll('span, div, p, td, b, strong')).filter(el => el.textContent.trim().toLowerCase().includes('referente a') && el.offsetParent !== null);
                    return faturas.length > 0;
                });

                if (!faturasNaTela) {
                    await pageEq.evaluate(() => {
                        const menuAgencia = Array.from(document.querySelectorAll('a, span, div, li, p')).find(el => el.textContent.trim().toUpperCase() === 'AGÊNCIA WEB');
                        if(menuAgencia) { menuAgencia.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); menuAgencia.click(); }
                    });
                    await new Promise(r => setTimeout(r, 2000));

                    await pageEq.evaluate(() => {
                        const links = Array.from(document.querySelectorAll('a, span, div, button, li'));
                        const btn2via = links.find(el => el.textContent.trim().toLowerCase().includes('emitir segunda via') || el.textContent.trim().toLowerCase() === 'segunda via');
                        if(btn2via) btn2via.click();
                    });
                    
                    try { await pageEq.waitForFunction(() => document.body.innerText.toLowerCase().match(/\d{2}\/\d{2}\/\d{4}/), { timeout: 20000 }); } catch (e) {}
                    await new Promise(r => setTimeout(r, 3000)); 
                } 

                await pageEq.evaluate(() => {
                    const toggle = Array.from(document.querySelectorAll('label, span, div, p')).find(el => el.textContent.toLowerCase().includes('exibir apenas faturas não pagas'));
                    if (toggle) { const checkbox = toggle.parentElement?.querySelector('input[type="checkbox"]'); if (checkbox && checkbox.checked) toggle.click(); }
                });
                await new Promise(r => setTimeout(r, 2500)); 

                for (let indiceFatura = 0; indiceFatura < 3; indiceFatura++) {
                    const alvoFatura = await pageEq.evaluate((index) => {
                        const linhasTabela = Array.from(document.querySelectorAll('tbody tr')).filter(tr => tr.offsetParent !== null && tr.textContent.trim().length > 10);
                        if (linhasTabela.length > index) {
                            linhasTabela[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
                            const rect = linhasTabela[index].getBoundingClientRect();
                            return { encontrou: true, x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) };
                        }
                        return { encontrou: false };
                    }, indiceFatura);

                    if (alvoFatura.encontrou) {
                        await pageEq.mouse.click(alvoFatura.x, alvoFatura.y);
                        await new Promise(r => setTimeout(r, 500));
                        await pageEq.mouse.click(alvoFatura.x, alvoFatura.y);
                        await new Promise(r => setTimeout(r, 4000));

                        const alvoBotao = await pageEq.evaluate(() => {
                            const btn = Array.from(document.querySelectorAll('*')).find(el => {
                                const txt = el.textContent.trim().toUpperCase();
                                const title = (el.getAttribute('title') || '').toUpperCase();
                                const classList = (el.getAttribute('class') || '').toUpperCase();
                                return (txt === 'BAIXAR' || txt === 'IMPRIMIR' || txt === 'VER FATURA' || txt === 'PDF' || title.includes('IMPRIMIR') || title.includes('DOWNLOAD') || classList.includes('FA-FILE-PDF')) && el.offsetParent !== null; 
                            });

                            if (btn) {
                                btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                if (btn.tagName === 'A') { btn.removeAttribute('target'); btn.setAttribute('target', '_self'); }
                                const atualOnclick = btn.getAttribute('onclick') || '';
                                if (atualOnclick.includes('window.open')) { btn.setAttribute('onclick', atualOnclick.replace(/window\.open\(([^,]+)[^)]*\)/, 'window.location.href=$1')); }
                                try { btn.click(); } catch(e){}
                                const rect = btn.getBoundingClientRect();
                                return { encontrou: true, x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) };
                            }
                            return { encontrou: false };
                        });

                        if (alvoBotao.encontrou) {
                            await pageEq.mouse.click(alvoBotao.x, alvoBotao.y);
                            for (let i = 0; i < 15; i++) {
                                await new Promise(r => setTimeout(r, 1000)); 
                                try {
                                    const arquivosTmp = fs.readdirSync('/tmp').filter(f => f.endsWith('.pdf'));
                                    for (let arq of arquivosTmp) {
                                        if (arq !== path.basename(caminhoFaturaLocal) && arq !== 'ultima_fatura.pdf') { fs.renameSync(path.join('/tmp', arq), caminhoFaturaLocal); pdfCapturado = true; break; }
                                    }
                                } catch(e){}
                                if (pdfCapturado || fs.existsSync(caminhoFaturaLocal)) { pdfCapturado = true; break; }
                            }
                            
                            if (pdfCapturado) break; 
                            
                            try {
                                const isPDF = await pageEq.evaluate(() => document.contentType === 'application/pdf' || document.querySelector('embed[type="application/pdf"]') !== null);
                                if (isPDF || pageEq.url().toLowerCase().includes('.pdf')) {
                                    const bufferArray = await pageEq.evaluate(async (url) => { const res = await fetch(url); const buf = await res.arrayBuffer(); return Array.from(new Uint8Array(buf)); }, pageEq.url());
                                    fs.writeFileSync(caminhoFaturaLocal, Buffer.from(bufferArray));
                                    pdfCapturado = true;
                                    break;
                                }
                            } catch(e){}
                        } else {
                            await pageEq.mouse.click(alvoFatura.x, alvoFatura.y + 60); 
                            await pageEq.evaluate(() => { Array.from(document.querySelectorAll('button, a, i, svg')).filter(e => e.offsetParent !== null).forEach(b => { try { b.click(); } catch(e){} }); });
                        }
                    } else { break; }
                }

                if (!pdfCapturado) {
                    await new Promise(r => setTimeout(r, 6000)); 
                    const abas = await browserEquatorial.pages();
                    for (let aba of abas) {
                        try {
                            const isPDF = await aba.evaluate(() => document.contentType === 'application/pdf' || document.querySelector('embed[type="application/pdf"]') !== null);
                            if (isPDF || aba.url().toLowerCase().includes('.pdf')) {
                                const bufferArray = await aba.evaluate(async (url) => { const res = await fetch(url); const buf = await res.arrayBuffer(); return Array.from(new Uint8Array(buf)); }, aba.url());
                                fs.writeFileSync(caminhoFaturaLocal, Buffer.from(bufferArray));
                                if (fs.existsSync(caminhoFaturaLocal)) { pdfCapturado = true; break; }
                            } else {
                                const textoAba = await aba.evaluate(() => document.body.innerText.toLowerCase());
                                if (textoAba.includes('total a pagar') || textoAba.includes('referente a') || textoAba.includes('conta de energia') || textoAba.includes('vencimento')) {
                                    await aba.emulateMediaType('screen');
                                    await aba.pdf({ path: caminhoFaturaLocal, format: 'A4', printBackground: true });
                                    if (fs.existsSync(caminhoFaturaLocal)) { pdfCapturado = true; break; }
                                }
                            }
                        } catch(e){}
                    }
                }

                if (!pdfCapturado || !fs.existsSync(caminhoFaturaLocal) || fs.statSync(caminhoFaturaLocal).size < 15000) {
                    throw new Error("FALHA_PDF_EQUATORIAL");
                }

                console.log(`[RPA] 🎉 Operação no Motor 2 concluída com sucesso! PDF garantido.`);
                await browserEquatorial.close().catch(()=>{});
                if (proxyUrlForPuppeteer) await closeAnonymizedProxy(proxyUrlForPuppeteer, true).catch(()=>{});
                break; 
            } catch (err) {
                if (browserEquatorial) await browserEquatorial.close().catch(()=>{});
                if (proxyUrlForPuppeteer) await closeAnonymizedProxy(proxyUrlForPuppeteer, true).catch(()=>{});
                await new Promise(r => setTimeout(r, 3000));
            }
        } 

        if (!pdfCapturado || !fs.existsSync(caminhoFaturaLocal)) {
            throw new Error("FALHA_PDF_EQUATORIAL");
        }

        try { fs.copyFileSync(caminhoFaturaLocal, path.join('/tmp', 'ultima_fatura.pdf')); } catch (e) {}

        // ==============================================================
        // RETORNO AO MOTOR 1 (IGREEN) PARA FINALIZAR O SERVIÇO
        // ==============================================================
        console.log(`[RPA] ⚡ Retornando ao MOTOR 1 (iGreen) para injetar o ficheiro...`);
        const pages = await browserIgreen.pages();
        const pageIgreenFinal = pages[pages.length - 1];
        await pageIgreenFinal.bringToFront();

        try { await pageIgreenFinal.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não') || el.textContent.includes('Fechar')); if(btn) btn.click(); }); } catch(e){}

        let searchDevolutiva = await pageIgreenFinal.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 });
        await searchDevolutiva.click({ clickCount: 3 });
        await pageIgreenFinal.keyboard.press('Backspace');
        await searchDevolutiva.type(cpf, { delay: 100 });
        await pageIgreenFinal.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 2000));

        await pageIgreenFinal.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 9999); });
        await new Promise(r => setTimeout(r, 1500));

        await pageIgreenFinal.evaluate((cpfBusca) => { 
            const linhas = Array.from(document.querySelectorAll('tr, [role="row"], div[class*="MuiDataGrid-row"]')); 
            const linhaExata = linhas.find(row => row.textContent.replace(/\D/g, '').includes(cpfBusca)); 
            if(linhaExata) {
                const btnTresPontinhos = Array.from(linhaExata.querySelectorAll('button, div')).find(el => el.textContent.trim() === '...'); 
                if(btnTresPontinhos) btnTresPontinhos.click(); 
            }
        }, cpf);
        await new Promise(r => setTimeout(r, 2000));

        await pageIgreenFinal.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, li, div')).find(el => el.textContent.includes('Devolutivas')); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 3000));

        for (let clique = 0; clique < 3; clique++) {
            await pageIgreenFinal.evaluate(() => { 
                const botoesAcao = Array.from(document.querySelectorAll('button, span, a, div')).filter(el => el.textContent.trim() === 'Realizar ação' || el.textContent.includes('Realizar ação'));
                const btn = botoesAcao.filter(b => b.offsetParent !== null).pop() || botoesAcao[botoesAcao.length - 1]; 
                if(btn) { btn.scrollIntoView({behavior: 'smooth', block: 'center'}); btn.click(); }
            });
            await new Promise(r => setTimeout(r, 3000));
        }

        const inputUploads = await pageIgreenFinal.$$('input[type="file"]');
        if (inputUploads.length > 0) {
            for (let input of inputUploads) {
                try {
                    await input.uploadFile(caminhoFaturaLocal);
                    await pageIgreenFinal.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);
                } catch(e){}
            }
        } else {
             throw new Error("O formulário de anexo da iGreen está bloqueado ou invisível.");
        }
        await new Promise(r => setTimeout(r, 3000));

        await pageIgreenFinal.evaluate(() => { 
            const btnSalvar = Array.from(document.querySelectorAll('button')).find(el => el.textContent.toUpperCase().includes('ENVIAR') || el.textContent.toUpperCase().includes('SALVAR') || el.textContent.toUpperCase().includes('CONCLUIR')); 
            if (btnSalvar) btnSalvar.click(); 
        });
        await new Promise(r => setTimeout(r, 5000)); 
        
        if (browserIgreen) await browserIgreen.close().catch(()=>{});
        if (fs.existsSync(caminhoFaturaLocal)) fs.unlinkSync(caminhoFaturaLocal);

        if(!isAutomated) await enviarMensagem(phone, TEXTOS.T_RESGATE_SUCESSO);
        
    } catch (e) { 
        console.error("\n❌ [RPA ERRO FATAL]:", e.message);
        if (browserIgreen) await browserIgreen.close().catch(()=>{}); 
        if (browserEquatorial) await browserEquatorial.close().catch(()=>{}); 
        if (fs.existsSync(caminhoFaturaLocal)) fs.unlinkSync(caminhoFaturaLocal).catch(()=>{});
        
        if(!isAutomated) {
            if (e.message === "ERRO_LOGIN_IGREEN") {
                await enviarMensagem(phone, "⚠️ *Falha na iGreen*\n\nO robô não conseguiu fazer login no escritório virtual. Verifique se a senha está correta no painel da Railway.");
            } else if (e.message === "LINHA_CLIENTE_NAO_ENCONTRADA") {
                await enviarMensagem(phone, "⚠️ *Cliente Não Encontrado*\n\nO robô acedeu ao Mapa de Clientes da iGreen, mas a linha com o nome/ID procurado não existe na tabela.");
            } else if (e.message === "FALTAM_DADOS_ESSENCIAIS") {
                await enviarMensagem(phone, "⚠️ *Dados Incompletos na iGreen*\n\nO robô achou o cliente, mas o CPF ou Data de Nascimento estão em branco no painel da iGreen. Sem isto, não conseguimos abrir a Equatorial.");
            } else {
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA_DEVOLUTIVA_MANUAL', cpfAlvo: cpf });
                await enviarMensagem(phone, TEXTOS.T_FALHA_EQUATORIAL_PEDE_FATURA);
            }
        }
    }
}

// ==========================================
// MÓDULO 3: MOTOR RECORRENTE (A CADA 24H)
// ==========================================
function iniciarMotorRecorrente() {
    setInterval(async () => {
        if (admin.apps.length > 0) {
            try {
                const db = admin.firestore();
                const snapshot = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads')
                                        .where('STATUS_CADASTRO', '==', 'PENDENTE_MEDIA').get();
                
                snapshot.forEach(async (doc) => {
                    const lead = doc.data();
                    const ultimaVerificacao = lead.DATA_ULTIMA_ATUALIZACAO ? lead.DATA_ULTIMA_ATUALIZACAO.toDate() : new Date();
                    const diasPassados = Math.floor((new Date() - ultimaVerificacao) / (1000 * 60 * 60 * 24));
                    
                    if (diasPassados >= 15) {
                        fluxoResgateDevolutiva(lead.NOME_CLIENTE, lead.TELEFONE_REMETENTE, lead.CPF, lead.DATA_NASCIMENTO, true);
                        await salvarNoBanco(doc.id, lead.TELEFONE_REMETENTE, { STATUS_CADASTRO: 'PENDENTE_MEDIA' }); 
                    }
                });
            } catch (e) { console.error("Erro no Cron:", e.message); }
        }
    }, 86400000); 
}
iniciarMotorRecorrente();

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
    
    if (textoIn) {
        console.log(`[WHATSAPP] 📩 Mensagem de ${phone}: "${textoIn}"`);
    } else if (data.image?.imageUrl || data.document?.documentUrl) {
        console.log(`[WHATSAPP] 📎 Mídia/Arquivo recebido de ${phone}`);
    }

    const temMidia = !!(data.image?.imageUrl || data.document?.documentUrl);
    const mediaUrl = data.image?.imageUrl || data.document?.documentUrl;
    const mimeType = data.document ? 'application/pdf' : 'image/jpeg';

    if (['0', 'cancelar', 'menu'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'NOVO' });
        await enviarMensagem(phone, "🔄 Operação cancelada.\n\n" + TEXTOS.T_MENU);
        return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };

    if (mem.STATUS_CADASTRO === 'NOVO') {
        if (txtL === '1') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA' }); await enviarMensagem(phone, TEXTOS.T01); return; }
        if (txtL === '2') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA_SOH_BANCO' }); await enviarMensagem(phone, TEXTOS.T_GUARDAR_START); return; }
        if (txtL === '3') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DADOS_DEVOLUTIVA' }); await enviarMensagem(phone, TEXTOS.T_RESGATE_START); return; }
        if (txtL === '4') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_UC_DOC' }); await enviarMensagem(phone, TEXTOS.T_START_OPCAO_4); return; }
        await enviarMensagem(phone, TEXTOS.T_MENU);
        return;
    }

    switch (mem.STATUS_CADASTRO) {
        case 'AGUARDANDO_FATURA': {
            if (temMidia) {
                await enviarMensagem(phone, TEXTOS.T02); 
                try {
                    const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
                    const docId = dadosIA.UC ? dadosIA.UC.replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
                    await salvarNoBanco(docId, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "CONCLUIDO" });
                    await enviarMensagem(phone, `✅ Tudo certo! Titular: ${dadosIA.NOME_CLIENTE}. Especialista entrará em contato.`);
                    memoriaEstado.delete(phone); 
                } catch (e) { await enviarMensagem(phone, "❌ Erro ao ler fatura."); }
            } else { await enviarMensagem(phone, "⚠️ Aguardando foto/PDF da fatura."); }
            break;
        }

        // 🔥 O FLUXO DO PLANO B (AQUI RECEBEMOS O PDF MANUAL)
        case 'AGUARDANDO_FATURA_DEVOLUTIVA_MANUAL': {
            if (temMidia) {
                const cpfAlvo = mem.cpfAlvo; // Recuperamos o CPF de quem estávamos a tentar salvar
                memoriaEstado.delete(phone); // Limpamos a memória do celular
                
                // 1. Atualizar Cadastro e Banco de Dados (como você pediu!)
                try {
                    const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
                    const docId = dadosIA.UC ? dadosIA.UC.replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
                    await salvarNoBanco(docId, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "CONCLUIDO" });
                } catch (e) {
                    console.log("[IA] Aviso: A IA não conseguiu ler o PDF perfeitamente para o Banco, mas o arquivo será injetado na iGreen na mesma.");
                }

                // 2. Acionar a injeção manual na iGreen (Devolutiva)
                injetarFaturaManualIgreen(cpfAlvo, mediaUrl, phone);
                
            } else { 
                await enviarMensagem(phone, "⚠️ Por favor, envie a foto ou arquivo PDF da fatura para resolvermos a devolutiva."); 
            }
            break;
        }

        case 'AGUARDANDO_FATURA_SOH_BANCO': {
            if (temMidia) {
                await enviarMensagem(phone, TEXTOS.T02); 
                try {
                    const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
                    const docId = dadosIA.UC ? dadosIA.UC.replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
                    await salvarNoBanco(docId, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "AGUARDANDO_TELEFONE" });
                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TELEFONE', docId });
                    await enviarMensagem(phone, TEXTOS.T_PEDIR_TELEFONE.replace('${nome}', dadosIA.NOME_CLIENTE).replace('${uc}', dadosIA.UC));
                } catch (e) { await enviarMensagem(phone, "❌ Erro na análise."); }
            } else { await enviarMensagem(phone, "⚠️ Aguardando foto/PDF da fatura."); }
            break;
        }

        case 'AGUARDANDO_TELEFONE': {
            if (textoIn.length >= 8) { 
                await salvarNoBanco(mem.docId, phone, { TELEFONE: textoIn, STATUS_CADASTRO: "AGUARDANDO_EMAIL" });
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_EMAIL', docId: mem.docId });
                await enviarMensagem(phone, TEXTOS.T_PEDIR_EMAIL);
            } else { await enviarMensagem(phone, "⚠️ Digite um telefone válido."); }
            break;
        }

        case 'AGUARDANDO_EMAIL': {
            if (textoIn.includes('@')) { 
                await salvarNoBanco(mem.docId, phone, { EMAIL: textoIn, STATUS_CADASTRO: "PENDENTE_DOCUMENTOS" });
                await enviarMensagem(phone, TEXTOS.T_FIM_PRE_CADASTRO);
                memoriaEstado.delete(phone);
            } else { await enviarMensagem(phone, "⚠️ Digite um e-mail válido."); }
            break;
        }

        case 'AGUARDANDO_DADOS_DEVOLUTIVA': {
            if (textoIn.length >= 3) {
                await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO);
                memoriaEstado.delete(phone); 
                
                setTimeout(() => { fluxoResgateDevolutiva(textoIn, phone, null, null, false); }, 2000);
            } else {
                await enviarMensagem(phone, "⚠️ Digite o Nome ou ID corretamente (mínimo de 3 caracteres).");
            }
            break;
        }

        case 'AGUARDANDO_UC_DOC': {
            if (textoIn.length >= 4) { 
                const ucLimpa = textoIn.replace(/\D/g, '');
                const leadExistente = await buscarNoBanco(ucLimpa);
                
                if (leadExistente) {
                    if (!leadExistente.TELEFONE) {
                        memoriaEstado.set(phone, { STATUS_CADASTRO: 'OP4_PEDIR_TELEFONE', docId: ucLimpa });
                        await enviarMensagem(phone, TEXTOS.T_OP4_FALTANDO_TEL);
                    } else if (!leadExistente.EMAIL) {
                        memoriaEstado.set(phone, { STATUS_CADASTRO: 'OP4_PEDIR_EMAIL', docId: ucLimpa });
                        await enviarMensagem(phone, TEXTOS.T_OP4_FALTANDO_MAIL);
                    } else {
                        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: ucLimpa });
                        await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE);
                    }
                } else {
                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: ucLimpa });
                    await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE);
                }
            } else { await enviarMensagem(phone, "⚠️ Digite a UC corretamente."); }
            break;
        }

        case 'OP4_PEDIR_TELEFONE': {
            if (textoIn.length >= 8) {
                await salvarNoBanco(mem.docId, phone, { TELEFONE: textoIn });
                const leadAtualizadoTel = await buscarNoBanco(mem.docId);
                
                if (leadAtualizadoTel && !leadAtualizadoTel.EMAIL) {
                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'OP4_PEDIR_EMAIL', docId: mem.docId });
                    await enviarMensagem(phone, TEXTOS.T_OP4_FALTANDO_MAIL);
                } else {
                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: mem.docId });
                    await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE);
                }
            } else { await enviarMensagem(phone, "⚠️ Digite um telefone válido."); }
            break;
        }

        case 'OP4_PEDIR_EMAIL': {
            if (textoIn.includes('@')) {
                await salvarNoBanco(mem.docId, phone, { EMAIL: textoIn });
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: mem.docId });
                await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE);
            } else { await enviarMensagem(phone, "⚠️ Digite um e-mail válido."); }
            break;
        }

        case 'AGUARDANDO_DOC_FRENTE': {
            if (temMidia) {
                await salvarNoBanco(mem.docId, phone, { LINK_DOC_FRENTE: mediaUrl });
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_VERSO', docId: mem.docId });
                await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_VERSO);
            } else { await enviarMensagem(phone, "⚠️ Envie a foto da FRENTE."); }
            break;
        }

        case 'AGUARDANDO_DOC_VERSO': {
            if (temMidia) {
                await salvarNoBanco(mem.docId, phone, { LINK_DOC_VERSO: mediaUrl, STATUS_CADASTRO: "CONCLUIDO_COM_DOCS" });
                await enviarMensagem(phone, TEXTOS.T_DOCS_RECEBIDOS);
                memoriaEstado.delete(phone);
            } else { await enviarMensagem(phone, "⚠️ Envie a foto do VERSO."); }
            break;
        }
    }
});

// ==========================================
// ROTA DE DEBUG: CÂMERA DE VIGILÂNCIA DO ROBÔ
// ==========================================
app.get('/tela-robo', (req, res) => {
    const file = path.join('/tmp', 'debug_tela.png');
    if (fs.existsSync(file)) {
        res.contentType('image/png');
        res.sendFile(path.resolve(file));
    } else {
        res.status(404).send(`
            <h2 style="font-family: sans-serif; color: #333; text-align: center; margin-top: 50px;">
                🕵️‍♂️ A câmera ainda não tirou nenhuma foto!
            </h2>
            <p style="font-family: sans-serif; color: #666; text-align: center;">
                Rode o teste no WhatsApp primeiro. Quando o robô entrar na Equatorial, a foto da tela dele vai aparecer aqui.
            </p>
        `);
    }
});

// ==========================================
// ROTA PÚBLICA DE PROVAS (A PEDIDO DO MESTRE)
// ==========================================
app.get('/ultima-fatura', (req, res) => {
    const file = path.join('/tmp', 'ultima_fatura.pdf');
    if (fs.existsSync(file)) {
        res.contentType('application/pdf');
        res.sendFile(path.resolve(file));
    } else {
        res.status(404).send(`
            <h2 style="font-family: sans-serif; color: #333; text-align: center; margin-top: 50px;">
                🕵️‍♂️ Nenhuma fatura foi capturada ainda!
            </h2>
            <p style="font-family: sans-serif; color: #666; text-align: center;">
                Faça o teste de uma Devolutiva no WhatsApp primeiro. Quando o robô gerar o PDF na Equatorial, ele aparecerá aqui.
            </p>
        `);
    }
});

// ==========================================
// HEALTH CHECK E INICIALIZAÇÃO
// ==========================================
const PORT = process.env.PORT || 10000;

async function validateBrowser() {
    try {
        console.log("⏳ Iniciando Health Check do Navegador (Modo Docker)...");
        const browser = await puppeteer.launch({
            headless: "new",
            args: CHROME_ARGS, 
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath()
        });
        await browser.close();
        console.log('✔ Browser health check passed! O contentor Docker está perfeito.');
        return true;
    } catch (error) {
        console.error('❌ Browser initialization failed:', error.message);
        process.exit(1); 
    }
}

// ROTA DE SEGURANÇA PARA A RAILWAY
app.get('/', (req, res) => res.status(200).send('Sistema iGreen Online e Blindado!'));

validateBrowser().then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor rodando a 100% na porta ${PORT} via Docker (0.0.0.0)`));
});    
