import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json());

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

const TEXTOS = {
    T_MENU: "👋 Olá! Bem-vindo ao *Atendimento Inteligente iGreen*. \n\nComo posso ajudar hoje? Escolha uma das opções abaixo enviando apenas o número:\n\n1️⃣ *Enviar Fatura* (Tratar Novo Cliente, Devolutivas e Atualizar Banco de Dados)\n2️⃣ *Pré-Cadastro* (Salvar dados básicos)\n3️⃣ *Resolver Devolutiva (Modo Auto)* (O robô tenta ir à Distribuidora)\n4️⃣ *Enviar Documentos* (Anexar RG ou CNH pendentes)\n\n_(Dica: Digite *0* a qualquer momento para voltar a este menu)_",
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
    "--disable-features=IsolateOrigins,site-per-process", 
    "--window-size=1920,1080",
    "--ignore-certificate-errors"
];

async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { 
        await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numLimpo, message: String(message) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' } }); 
    } catch (e) { console.error(`[Z-API] Erro:`, e.message); }
}

async function buscarNoBanco(docId) {
    if (admin.apps.length > 0) {
        try {
            const doc = await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(docId).get();
            return doc.exists ? doc.data() : null;
        } catch (e) { return null; }
    }
    return null;
}

function limparDadosVazios(dados) { return Object.fromEntries(Object.entries(dados).filter(([_, v]) => v !== "" && v !== "Não extraído" && v !== "0" && v !== null && v !== undefined)); }

async function salvarNoBanco(docId, phone, dadosExtras) {
    if (admin.apps.length > 0) {
        try {
            const dadosLimpos = limparDadosVazios(dadosExtras); 
            await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(docId).set({ ...dadosLimpos, TELEFONE_REMETENTE: phone, DATA_ULTIMA_ATUALIZACAO: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        } catch (e) { console.error("Erro Firebase:", e.message); }
    }
}

async function analisarFaturaGemini(mediaUrl, mimeType) {
    try {
        console.log(`\n[IA GEMINI] 📥 Iniciando download do arquivo na Z-API: ${mediaUrl}`);
        const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
        if (!response.data || response.data.length === 0) throw new Error("O ficheiro baixado está vazio.");

        const base64Data = Buffer.from(response.data, 'binary').toString('base64');
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        
        const promptText = `Extraia os dados desta fatura de energia em formato JSON. Use EXATAMENTE estas chaves: 
        "NOME_CLIENTE", "CPF" (APENAS se o número for puro sem asteriscos, senão deixe vazio ""), "MASCARA_CPF" (use esta chave se tiver asteriscos ex: ***.123.456-**), "DATA_NASCIMENTO", "UC", "CONTA_MES", "VENCIMENTO", "VALOR_FATURA", 
        "CEP", "ENDERECO", "ENDERECO_NUMERO", "ENDERECO_COMPLEMENTO", "ESTADO", "DISTRIBUIDORA", "MEDIA_CONSUMO",
        "CONSUMO_MES_1", "CONSUMO_MES_2", "CONSUMO_MES_3", "CONSUMO_MES_4", "CONSUMO_MES_5", "CONSUMO_MES_6", "CONSUMO_MES_7", "CONSUMO_MES_8", "CONSUMO_MES_9", "CONSUMO_MES_10", "CONSUMO_MES_11", "CONSUMO_MES_12". 
        Se não encontrar alguma informação, retorne uma string vazia "".`;

        const payload = {
            contents: [{ parts: [ { text: promptText }, { inline_data: { mime_type: mimeType === 'application/pdf' ? 'application/pdf' : 'image/jpeg', data: base64Data } } ] }],
            generationConfig: { responseMimeType: "application/json" }
        };

        const result = await axios.post(geminiUrl, payload, { headers: { 'Content-Type': 'application/json' } });
        return JSON.parse(result.data.candidates[0].content.parts[0].text);
    } catch (error) { throw new Error("Falha ao ler fatura."); }
}

async function varreduraIgreenDiaria() {
    let browserIgreen = null;
    try {
        console.log(`\n[VARREDURA DIÁRIA] 🕵️ Iniciando varredura autônoma no Relatório de Clientes iGreen...`);
        browserIgreen = await puppeteer.launch({ headless: true, args: CHROME_ARGS, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() });
        const pageIgreen = await browserIgreen.newPage(); 
        await pageIgreen.setViewport({ width: 1920, height: 1080 });
        
        await pageIgreen.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
        
        await pageIgreen.waitForSelector('input[type="email"]');
        await pageIgreen.type('input[type="email"]', IGREEN_USER, { delay: 50 });
        await pageIgreen.type('input[type="password"]', IGREEN_PASS, { delay: 50 });
        await pageIgreen.evaluate(() => { const btnEntrar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent.toLowerCase().includes('acessar')); if (btnEntrar) btnEntrar.click(); });
        await Promise.race([ pageIgreen.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }), new Promise(r => setTimeout(r, 10000)) ]);
        try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}

        console.log(`[VARREDURA DIÁRIA] Acessando Mapa de Clientes...`);
        await pageIgreen.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));
        await pageIgreen.evaluate(() => { document.body.style.zoom = "0.5"; }); 

        try {
            let searchInput = await pageIgreen.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 });
            await searchInput.click({ clickCount: 3 }); await pageIgreen.keyboard.press('Backspace');
            await searchInput.type('76049', { delay: 100 }); 
            await pageIgreen.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 6000)); 
        } catch(e) {}
        
        let todosClientes = new Map();

        for (let volta = 0; volta < 5; volta++) {
            await pageIgreen.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 0); }); await new Promise(r => setTimeout(r, 1500));
            let dadosEsq = await pageIgreen.evaluate(() => {
                let mapa = {};
                document.querySelectorAll('.MuiDataGrid-row').forEach(row => {
                    const id = row.getAttribute('data-id'); if(!id) return;
                    const cols = Array.from(row.querySelectorAll('.MuiDataGrid-cell'));
                    const codigo = cols[0]?.textContent?.trim() || "";
                    const nome = cols[1]?.textContent?.trim() || "";
                    const cpf = cols.find(c => c.textContent.match(/\d{3}\.\d{3}\.\d{3}-\d{2}/))?.textContent?.replace(/\D/g, '') || ""; 
                    mapa[id] = { codigo, nome, cpf };
                });
                return mapa;
            });

            await pageIgreen.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 9999); }); await new Promise(r => setTimeout(r, 1500));
            let dadosDir = await pageIgreen.evaluate(() => {
                let mapa = {};
                document.querySelectorAll('.MuiDataGrid-row').forEach(row => {
                    const id = row.getAttribute('data-id'); if(!id) return;
                    let nasc = null;
                    const todasDatas = row.textContent.match(/\d{2}\/\d{2}\/\d{4}/g);
                    if (todasDatas && todasDatas.length > 0) {
                        let menorAno = 9999; for (let d of todasDatas) { let ano = parseInt(d.split('/')[2], 10); if (ano < menorAno) { menorAno = ano; nasc = d; } } if (menorAno > 2015) nasc = null;
                    }
                    mapa[id] = { nasc };
                });
                return mapa;
            });

            for (let id in dadosEsq) {
                if (dadosEsq[id].cpf && dadosEsq[id].nome) {
                    todosClientes.set(dadosEsq[id].cpf, { CODIGO_CLIENTE: dadosEsq[id].codigo, NOME_CLIENTE: dadosEsq[id].nome, CPF: dadosEsq[id].cpf, DATA_NASCIMENTO: dadosDir[id] ? dadosDir[id].nasc : null });
                }
            }
            await pageIgreen.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollTop += 600); }); await new Promise(r => setTimeout(r, 1500));
        }

        const clientesParaAtualizar = Array.from(todosClientes.values());
        console.log(`[VARREDURA DIÁRIA] Colheita concluída! Capturámos ${clientesParaAtualizar.length} clientes na rede.`);
        
        for (let cliente of clientesParaAtualizar) {
            if (cliente.CPF && cliente.CODIGO_CLIENTE) {
                if (admin.apps.length > 0) {
                    try {
                        // 🔥 A MÁGICA DA FUSÃO DE DADOS: O robô verifica TODAS as UCs atreladas a este CPF
                        const existingRef = await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').where('CPF', '==', cliente.CPF).get();
                        
                        if (!existingRef.empty) {
                            // Se o cliente já mandou mensagem no WhatsApp (1 ou mais UCs)
                            // O robô injeta o CÓDIGO e DATA_NASCIMENTO em todas as pastas sem apagar o Telefone/Fatura!
                            existingRef.forEach(async (doc) => {
                                await salvarNoBanco(doc.id, "SISTEMA_AUTONOMO", {
                                    CODIGO_CLIENTE: cliente.CODIGO_CLIENTE,
                                    DATA_NASCIMENTO: cliente.DATA_NASCIMENTO,
                                    NOME_CLIENTE: cliente.NOME_CLIENTE
                                });
                            });
                        } else {
                            // Se é um cliente 100% novo que nunca usou o WhatsApp
                            // O robô cria a pasta usando o CÓDIGO como Chave Mestra!
                            await salvarNoBanco(cliente.CODIGO_CLIENTE, "SISTEMA_AUTONOMO", {
                                CODIGO_CLIENTE: cliente.CODIGO_CLIENTE,
                                NOME_CLIENTE: cliente.NOME_CLIENTE,
                                CPF: cliente.CPF,
                                DATA_NASCIMENTO: cliente.DATA_NASCIMENTO
                            });
                        }
                    } catch(e) { console.error("Erro na fusão:", e.message); }
                }
            }
        }
        console.log(`[VARREDURA DIÁRIA] ✅ Banco de Dados atualizado (Fusão Inteligente ativada).\n`);
    } catch (e) { console.error(`❌ [ERRO VARREDURA DIÁRIA]:`, e.message); } finally { if (browserIgreen) await browserIgreen.close().catch(()=>{}); }
}

async function fluxoProcessamentoUniversal(mediaUrl, mimeType, phone, cpfAlvo = null) {
    const localPath = path.join('/tmp', `fatura_universal_${Date.now()}.pdf`);
    let browserIgreen = null;
    try {
        await enviarMensagem(phone, "📥 *Iniciando Fluxo Universal...*\n\n🤖 1️⃣ Analisando a fatura com Inteligência Artificial para capturar todos os dados...");
        let dadosIA; try { dadosIA = await analisarFaturaGemini(mediaUrl, mimeType); } catch (e) { await enviarMensagem(phone, "⚠️ A Inteligência Artificial teve dificuldade em ler o arquivo."); return; }
        const ucLimpa = dadosIA.UC ? String(dadosIA.UC).replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
        const cpfFatura = dadosIA.CPF ? String(dadosIA.CPF).replace(/\D/g, '') : null; const cpfFinal = cpfFatura || cpfAlvo; 
        await enviarMensagem(phone, `🔍 2️⃣ Verificando no nosso Banco de Dados Oficial se a UC *${ucLimpa}* já existe...`);
        await salvarNoBanco(ucLimpa, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "PROCESSADO_UNIVERSAL" }); await new Promise(r => setTimeout(r, 1500));
        if (!cpfFinal) { await enviarMensagem(phone, "⚠️ CPF não identificado na fatura. Salvo no banco, mas injeção na iGreen abortada."); return; }
        await enviarMensagem(phone, `🚀 3️⃣ Banco atualizado! Baixando o PDF e voando para o portal da iGreen para anexar (CPF Alvo: ${cpfFinal})...`);
        const response = await axios({ url: mediaUrl, method: 'GET', responseType: 'stream' }); const writer = fs.createWriteStream(localPath); response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        browserIgreen = await puppeteer.launch({ headless: true, args: CHROME_ARGS, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() });
        const pageIgreen = await browserIgreen.newPage(); await pageIgreen.setViewport({ width: 1920, height: 1080 });
        await pageIgreen.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
        await pageIgreen.waitForSelector('input[type="email"]', { timeout: 15000 }); await pageIgreen.type('input[type="email"]', IGREEN_USER, { delay: 50 }); await pageIgreen.type('input[type="password"]', IGREEN_PASS, { delay: 50 });
        await pageIgreen.evaluate(() => { const btnEntrar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent.toLowerCase().includes('acessar')); if (btnEntrar) btnEntrar.click(); });
        await Promise.race([ pageIgreen.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }), new Promise(resolve => setTimeout(resolve, 10000)) ]);
        try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
        await pageIgreen.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 }); await new Promise(r => setTimeout(r, 5000)); await pageIgreen.evaluate(() => { document.body.style.zoom = "0.4"; });
        let searchInput = await pageIgreen.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 });
        await searchInput.click({ clickCount: 3 }); await pageIgreen.keyboard.press('Backspace'); await searchInput.type(cpfFinal, { delay: 100 }); await pageIgreen.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 4000));
        await pageIgreen.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 9999); }); await new Promise(r => setTimeout(r, 1500));
        const clicouPontinhos = await pageIgreen.evaluate((cpfBusca) => { const linhas = Array.from(document.querySelectorAll('tr, [role="row"], div[class*="MuiDataGrid-row"]')); const linhaExata = linhas.find(row => row.textContent.replace(/\D/g, '').includes(cpfBusca)); if(linhaExata) { const btnTresPontinhos = Array.from(linhaExata.querySelectorAll('button, div')).find(el => el.textContent.trim() === '...'); if(btnTresPontinhos) { btnTresPontinhos.click(); return true; } } return false; }, cpfFinal);
        if (!clicouPontinhos) throw new Error("CLIENTE_NAO_ENCONTRADO_MAPA");
        await new Promise(r => setTimeout(r, 2000)); await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, li, div')).find(el => el.textContent.includes('Devolutivas')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 3000));
        for (let clique = 0; clique < 3; clique++) { await pageIgreen.evaluate(() => { const botoesAcao = Array.from(document.querySelectorAll('button, span, a, div')).filter(el => el.textContent.trim() === 'Realizar ação' || el.textContent.includes('Realizar ação')); const btn = botoesAcao.filter(b => b.offsetParent !== null).pop() || botoesAcao[botoesAcao.length - 1]; if(btn) { btn.scrollIntoView({behavior: 'smooth', block: 'center'}); btn.click(); } }); await new Promise(r => setTimeout(r, 3000)); }
        const inputUploads = await pageIgreen.$$('input[type="file"]');
        if (inputUploads.length > 0) { for (let input of inputUploads) { try { await input.uploadFile(localPath); await pageIgreen.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input); } catch(e){} } } else { throw new Error("O formulário de anexo da iGreen está bloqueado ou invisível."); }
        await new Promise(r => setTimeout(r, 3000)); await pageIgreen.evaluate(() => { const btnSalvar = Array.from(document.querySelectorAll('button')).find(el => el.textContent.toUpperCase().includes('ENVIAR') || el.textContent.toUpperCase().includes('SALVAR') || el.textContent.toUpperCase().includes('CONCLUIR')); if (btnSalvar) btnSalvar.click(); }); await new Promise(r => setTimeout(r, 5000));
        await enviarMensagem(phone, "🎉 *Fim do Processo Universal!*\n\n1️⃣ Banco de Dados Sincronizado 💾\n2️⃣ Fatura Anexada na iGreen 🌿\n\nA operação foi um Sucesso Absoluto!");
    } catch (e) {
        if (e.message === "CLIENTE_NAO_ENCONTRADO_MAPA") { await enviarMensagem(phone, "✅ A fatura foi guardada no *Nosso Banco de Dados*!\n\n⚠️ Contudo, o robô não anexou na iGreen porque este cliente ainda não aparece no seu Mapa de Clientes do escritório virtual."); } 
        else { await enviarMensagem(phone, "⚠️ A fatura foi salva no nosso Banco, mas ocorreu um erro ao tentar anexar na iGreen."); }
    } finally { if (browserIgreen) await browserIgreen.close().catch(()=>{}); if (fs.existsSync(localPath)) fs.unlinkSync(localPath).catch(()=>{}); }
}

async function fluxoResgateDevolutiva(termoBuscaIgreen, phone, cpfBanco = null, nascBanco = null, isAutomated = false) {
    let browserIgreen = null; let browserEquatorial = null; const caminhoFaturaLocal = path.join('/tmp', `fatura_${Date.now()}.pdf`); let cpf = cpfBanco; let nascimento = nascBanco; let ucExtraidaEquatorial = null; let pdfCapturado = false;
    try {
        browserIgreen = await puppeteer.launch({ headless: true, args: CHROME_ARGS, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() }); const pageIgreen = await browserIgreen.newPage(); await pageIgreen.setViewport({ width: 1920, height: 1080 }); 
        if (!cpf || !nascimento) {
            await pageIgreen.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 }); try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
            await pageIgreen.waitForSelector('input[type="email"]'); await pageIgreen.type('input[type="email"]', IGREEN_USER, { delay: 50 }); await pageIgreen.type('input[type="password"]', IGREEN_PASS, { delay: 50 });
            await pageIgreen.evaluate(() => { const btnEntrar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent.toLowerCase().includes('acessar')); if (btnEntrar) btnEntrar.click(); });
            await Promise.race([ pageIgreen.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }), new Promise(resolve => setTimeout(resolve, 10000)) ]); if (pageIgreen.url().includes('login')) throw new Error("ERRO_LOGIN_IGREEN");
            try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
            await pageIgreen.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 }); await new Promise(r => setTimeout(r, 5000)); await pageIgreen.evaluate(() => { document.body.style.zoom = "0.4"; });
            let searchInput; try { searchInput = await pageIgreen.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 }); } catch (e) { throw new Error("LINHA_CLIENTE_NAO_ENCONTRADA"); }
            await searchInput.click(); await searchInput.click({ clickCount: 3 }); await pageIgreen.keyboard.press('Backspace'); await searchInput.type(termoBuscaIgreen, { delay: 100 }); await pageIgreen.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 3000));
            await pageIgreen.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 0); }); await new Promise(r => setTimeout(r, 1500));
            let extraidosEsq = await pageIgreen.evaluate((busca) => { const linhas = Array.from(document.querySelectorAll('tr, [role="row"], .MuiDataGrid-row')); const l = linhas.find(x => x.textContent.toLowerCase().includes(busca.toLowerCase().trim())); if(!l) return { texto: "", codigo: "", nome: "" }; const cols = Array.from(l.querySelectorAll('.MuiDataGrid-cell, td')); return { texto: l.textContent, codigo: cols[0]?.textContent?.trim() || "", nome: cols[1]?.textContent?.trim() || "" }; }, termoBuscaIgreen);
            await pageIgreen.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 9999); }); await new Promise(r => setTimeout(r, 1500));
            const dadosExtraidos = await pageIgreen.evaluate((busca, esqTexto) => { const linhas = Array.from(document.querySelectorAll('tr, [role="row"], .MuiDataGrid-row')); let linhaExata = linhas.find(l => l.textContent.toLowerCase().includes(busca.toLowerCase().trim())); if (!linhaExata && linhas.length > 1) linhaExata = linhas[1]; let textoCompleto = esqTexto + "   " + (linhaExata ? linhaExata.textContent : ""); let cpfExt = null; let nascExt = null; const cpfMatch = textoCompleto.match(/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/); if (cpfMatch) cpfExt = cpfMatch[0].replace(/\D/g, ''); const todasDatas = textoCompleto.match(/\d{2}\/\d{2}\/\d{4}/g); if (todasDatas && todasDatas.length > 0) { let menorAno = 9999; for (let d of todasDatas) { let ano = parseInt(d.split('/')[2], 10); if (ano < menorAno) { menorAno = ano; nascExt = d; } } if (menorAno > 2015) nascExt = null; } if (!cpfExt || !nascExt) return { falhouBusca: true }; return { cpfExt, nascExt }; }, termoBuscaIgreen, extraidosEsq.texto);
            if (dadosExtraidos && dadosExtraidos.falhouBusca) throw new Error("FALTAM_DADOS_ESSENCIAIS");
            cpf = dadosExtraidos.cpfExt; nascimento = dadosExtraidos.nascExt;
            await salvarNoBanco(cpf, phone, { CODIGO_CLIENTE: extraidosEsq.codigo, CPF: cpf, DATA_NASCIMENTO: nascimento, NOME_CLIENTE: extraidosEsq.nome || termoBuscaIgreen });
        }
        for (let tentativa = 1; tentativa <= 3; tentativa++) {
            let proxyUrlForPuppeteer = null;
            try {
                let puppeteerArgsEq = [...CHROME_ARGS];
                if (PROXY_IP && PROXY_PORT && PROXY_USER && PROXY_PASS) { const rawProxyUrl = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_IP}:${PROXY_PORT}`; const proxyPromise = anonymizeProxy(rawProxyUrl); const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout Proxy")), 20000)); proxyUrlForPuppeteer = await Promise.race([proxyPromise, timeoutPromise]); puppeteerArgsEq.push(`--proxy-server=${proxyUrlForPuppeteer}`); } 
                browserEquatorial = await puppeteer.launch({ headless: true, args: puppeteerArgsEq, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(), defaultViewport: { width: 1920, height: 1080 } }); const pageEq = await browserEquatorial.newPage(); 
                await pageEq.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); window.chrome = { runtime: {} }; });
                await pageEq.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
                await pageEq.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7', 'Upgrade-Insecure-Requests': '1', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8' });
                const clientEq = await pageEq.target().createCDPSession(); await clientEq.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' });
                const escutarPDF = async (response) => { try { const contentType = response.headers()['content-type']; const contentDisposition = response.headers()['content-disposition']; if (response.status() === 200 && ((contentType && contentType.includes('application/pdf')) || (contentDisposition && contentDisposition.includes('.pdf')))) { const buffer = await response.buffer(); fs.writeFileSync(caminhoFaturaLocal, buffer); } } catch(err) {} };
                pageEq.on('response', escutarPDF); browserEquatorial.on('targetcreated', async (target) => { if (target.type() === 'page') { try { const novaAba = await target.page(); novaAba.on('response', escutarPDF); } catch (e) {} } });
                await pageEq.goto(EQUATORIAL_AL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); await new Promise(r => setTimeout(r, 5000)); 
                const bodyTextInicio = await pageEq.evaluate(() => document.body.innerText.toLowerCase()); if (bodyTextInicio.includes("access denied") || bodyTextInicio.includes("error 16") || bodyTextInicio.includes("imperva")) throw new Error("IMPERVA_BLOCK");
                await pageEq.evaluate(() => { const btnSair = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase().includes('SAIR') || el.textContent.toUpperCase().includes('X SAIR')); if (btnSair) btnSair.click(); }); await new Promise(r => setTimeout(r, 4000)); 
                await pageEq.evaluate(() => { const check = document.querySelector('input[type="checkbox"]'); if(check) check.click(); const btnEnviar = Array.from(document.querySelectorAll('button, div, span')).find(el => el.textContent.toUpperCase().includes('ENVIAR')); if(btnEnviar) btnEnviar.click(); const btnFechar = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase() === 'FECHAR' || el.textContent.toUpperCase() === 'X'); if(btnFechar) btnFechar.click(); });
                let encontrouCpf = await pageEq.evaluate(() => { const inputs = Array.from(document.querySelectorAll('input')); let cpfField = inputs.find(i => (i.placeholder && i.placeholder.toLowerCase().includes('cpf')) || (i.id && i.id.toLowerCase().includes('cpf'))); if (cpfField) { cpfField.focus(); cpfField.click(); return true; } return false; });
                if (encontrouCpf) { await pageEq.keyboard.type(cpf, { delay: 100 }); await new Promise(r => setTimeout(r, 1000)); await pageEq.evaluate(() => { const btnEntrar = Array.from(document.querySelectorAll('button, a, div')).find(b => b.textContent.trim().toUpperCase() === 'ENTRAR' || b.textContent.trim().toUpperCase() === 'CONTINUAR'); if (btnEntrar) btnEntrar.click(); }); } await new Promise(r => setTimeout(r, 4000));
                let encontrouNasc = await pageEq.evaluate(() => { const inputs = Array.from(document.querySelectorAll('input')); let nascField = inputs.find(i => (i.placeholder && i.placeholder.toLowerCase().includes('nascimento')) || (i.id && i.id.toLowerCase().includes('nasc'))); if (nascField && nascField.offsetParent !== null) { nascField.focus(); nascField.click(); return true; } return false; });
                if (encontrouNasc) { await pageEq.keyboard.type(nascimento, { delay: 100 }); await new Promise(r => setTimeout(r, 1000)); await pageEq.evaluate(() => { const btnEntrar = Array.from(document.querySelectorAll('button, a, div')).find(b => b.textContent.trim().toUpperCase() === 'ENTRAR' || b.textContent.trim().toUpperCase() === 'CONTINUAR' || b.textContent.trim().toUpperCase() === 'ACESSAR'); if (btnEntrar) btnEntrar.click(); }); } await new Promise(r => setTimeout(r, 15000));
                await pageEq.evaluate(() => { const btnFechar = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase() === 'FECHAR' || el.textContent.toUpperCase() === 'X'); if(btnFechar) btnFechar.click(); }); await new Promise(r => setTimeout(r, 1000));
                await pageEq.evaluate(() => { const elementos = Array.from(document.querySelectorAll('a, button, span, div, h2, h3, p')); const linkEq = elementos.find(el => { const txt = el.textContent.trim().toUpperCase(); return (txt === 'EQUATORIAL ALAGOAS' || txt === 'ALAGOAS' || txt === 'ACESSAR' || txt === 'IR PARA O PORTAL' || txt.includes('EQUATORIAL')) && el.offsetParent !== null && txt.length < 35; }); if (linkEq) { linkEq.click(); if(linkEq.parentElement) linkEq.parentElement.click(); } }); await new Promise(r => setTimeout(r, 5000));
                const ucIdentificada = await pageEq.evaluate(() => { const elementos = Array.from(document.querySelectorAll('span, div, p, a, li, option, td, h3, h4, b, strong, select')); const elemUc = elementos.find(el => { const txt = el.textContent.trim(); if (txt.includes('/') || txt.includes('-') || txt.includes('.')) return false; const soNumeros = txt.replace(/\D/g, ''); return soNumeros.length >= 8 && soNumeros.length <= 15 && txt === soNumeros; }); if (elemUc) { elemUc.click(); if(elemUc.parentElement) elemUc.parentElement.click(); return elemUc.textContent.trim(); } return null; });
                if (ucIdentificada) { ucExtraidaEquatorial = ucIdentificada; await salvarNoBanco(cpf, phone, { UC_ATUALIZADA_EQUATORIAL: ucIdentificada, UC: ucIdentificada }); } await new Promise(r => setTimeout(r, 5000));
                let faturasNaTela = await pageEq.evaluate(() => { const faturas = Array.from(document.querySelectorAll('span, div, p, td, b, strong')).filter(el => el.textContent.trim().toLowerCase().includes('referente a') && el.offsetParent !== null); return faturas.length > 0; });
                if (!faturasNaTela) {
                    await pageEq.evaluate(() => { const menuAgencia = Array.from(document.querySelectorAll('a, span, div, li, p')).find(el => el.textContent.trim().toUpperCase() === 'AGÊNCIA WEB'); if(menuAgencia) { menuAgencia.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); menuAgencia.click(); } }); await new Promise(r => setTimeout(r, 2000));
                    await pageEq.evaluate(() => { const links = Array.from(document.querySelectorAll('a, span, div, button, li')); const btn2via = links.find(el => el.textContent.trim().toLowerCase().includes('emitir segunda via') || el.textContent.trim().toLowerCase() === 'segunda via'); if(btn2via) btn2via.click(); });
                    try { await pageEq.waitForFunction(() => document.body.innerText.toLowerCase().match(/\d{2}\/\d{2}\/\d{4}/), { timeout: 20000 }); } catch (e) {} await new Promise(r => setTimeout(r, 3000)); 
                } 
                await pageEq.evaluate(() => { const toggle = Array.from(document.querySelectorAll('label, span, div, p')).find(el => el.textContent.toLowerCase().includes('exibir apenas faturas não pagas')); if (toggle) { const checkbox = toggle.parentElement?.querySelector('input[type="checkbox"]'); if (checkbox && checkbox.checked) toggle.click(); } }); await new Promise(r => setTimeout(r, 2500)); 
                for (let indiceFatura = 0; indiceFatura < 3; indiceFatura++) {
                    const alvoFatura = await pageEq.evaluate((index) => { const linhasTabela = Array.from(document.querySelectorAll('tbody tr')).filter(tr => tr.offsetParent !== null && tr.textContent.trim().length > 10); if (linhasTabela.length > index) { linhasTabela[index].scrollIntoView({ behavior: 'smooth', block: 'center' }); const rect = linhasTabela[index].getBoundingClientRect(); return { encontrou: true, x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) }; } return { encontrou: false }; }, indiceFatura);
                    if (alvoFatura.encontrou) {
                        await pageEq.mouse.click(alvoFatura.x, alvoFatura.y); await new Promise(r => setTimeout(r, 500)); await pageEq.mouse.click(alvoFatura.x, alvoFatura.y); await new Promise(r => setTimeout(r, 4000));
                        const alvoBotao = await pageEq.evaluate(() => { const btn = Array.from(document.querySelectorAll('*')).find(el => { const txt = el.textContent.trim().toUpperCase(); const title = (el.getAttribute('title') || '').toUpperCase(); const classList = (el.getAttribute('class') || '').toUpperCase(); return (txt === 'BAIXAR' || txt === 'IMPRIMIR' || txt === 'VER FATURA' || txt === 'PDF' || title.includes('IMPRIMIR') || title.includes('DOWNLOAD') || classList.includes('FA-FILE-PDF')) && el.offsetParent !== null; }); if (btn) { btn.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (btn.tagName === 'A') { btn.removeAttribute('target'); btn.setAttribute('target', '_self'); } const atualOnclick = btn.getAttribute('onclick') || ''; if (atualOnclick.includes('window.open')) { btn.setAttribute('onclick', atualOnclick.replace(/window\.open\(([^,]+)[^)]*\)/, 'window.location.href=$1')); } try { btn.click(); } catch(e){} const rect = btn.getBoundingClientRect(); return { encontrou: true, x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) }; } return { encontrou: false }; });
                        if (alvoBotao.encontrou) {
                            await pageEq.mouse.click(alvoBotao.x, alvoBotao.y);
                            for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 1000)); try { const arquivosTmp = fs.readdirSync('/tmp').filter(f => f.endsWith('.pdf')); for (let arq of arquivosTmp) { if (arq !== path.basename(caminhoFaturaLocal) && arq !== 'ultima_fatura.pdf') { fs.renameSync(path.join('/tmp', arq), caminhoFaturaLocal); pdfCapturado = true; break; } } } catch(e){} if (pdfCapturado || fs.existsSync(caminhoFaturaLocal)) { pdfCapturado = true; break; } }
                            if (pdfCapturado) break; 
                            try { const isPDF = await pageEq.evaluate(() => document.contentType === 'application/pdf' || document.querySelector('embed[type="application/pdf"]') !== null); if (isPDF || pageEq.url().toLowerCase().includes('.pdf')) { const bufferArray = await pageEq.evaluate(async (url) => { const res = await fetch(url); const buf = await res.arrayBuffer(); return Array.from(new Uint8Array(buf)); }, pageEq.url()); fs.writeFileSync(caminhoFaturaLocal, Buffer.from(bufferArray)); pdfCapturado = true; break; } } catch(e){}
                        } else { await pageEq.mouse.click(alvoFatura.x, alvoFatura.y + 60); await pageEq.evaluate(() => { Array.from(document.querySelectorAll('button, a, i, svg')).filter(e => e.offsetParent !== null).forEach(b => { try { b.click(); } catch(e){} }); }); }
                    } else { break; }
                }
                if (!pdfCapturado) {
                    await new Promise(r => setTimeout(r, 6000)); const abas = await browserEquatorial.pages();
                    for (let aba of abas) { try { const isPDF = await aba.evaluate(() => document.contentType === 'application/pdf' || document.querySelector('embed[type="application/pdf"]') !== null); if (isPDF || aba.url().toLowerCase().includes('.pdf')) { const bufferArray = await aba.evaluate(async (url) => { const res = await fetch(url); const buf = await res.arrayBuffer(); return Array.from(new Uint8Array(buf)); }, aba.url()); fs.writeFileSync(caminhoFaturaLocal, Buffer.from(bufferArray)); if (fs.existsSync(caminhoFaturaLocal)) { pdfCapturado = true; break; } } else { const textoAba = await aba.evaluate(() => document.body.innerText.toLowerCase()); if (textoAba.includes('total a pagar') || textoAba.includes('referente a') || textoAba.includes('conta de energia') || textoAba.includes('vencimento')) { await aba.emulateMediaType('screen'); await aba.pdf({ path: caminhoFaturaLocal, format: 'A4', printBackground: true }); if (fs.existsSync(caminhoFaturaLocal)) { pdfCapturado = true; break; } } } } catch(e){} }
                }
                if (!pdfCapturado || !fs.existsSync(caminhoFaturaLocal) || fs.statSync(caminhoFaturaLocal).size < 15000) throw new Error("FALHA_PDF_EQUATORIAL");
                await browserEquatorial.close().catch(()=>{}); if (proxyUrlForPuppeteer) await closeAnonymizedProxy(proxyUrlForPuppeteer, true).catch(()=>{}); break; 
            } catch (err) { if (browserEquatorial) await browserEquatorial.close().catch(()=>{}); if (proxyUrlForPuppeteer) await closeAnonymizedProxy(proxyUrlForPuppeteer, true).catch(()=>{}); await new Promise(r => setTimeout(r, 3000)); }
        } 
        if (!pdfCapturado || !fs.existsSync(caminhoFaturaLocal)) throw new Error("FALHA_PDF_EQUATORIAL");
        try { fs.copyFileSync(caminhoFaturaLocal, path.join('/tmp', 'ultima_fatura.pdf')); } catch (e) {}

        const pages = await browserIgreen.pages(); const pageIgreenFinal = pages[pages.length - 1]; await pageIgreenFinal.bringToFront();
        try { await pageIgreenFinal.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não') || el.textContent.includes('Fechar')); if(btn) btn.click(); }); } catch(e){}
        let searchDevolutiva = await pageIgreenFinal.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 });
        await searchDevolutiva.click({ clickCount: 3 }); await pageIgreenFinal.keyboard.press('Backspace'); await searchDevolutiva.type(cpf, { delay: 100 }); await pageIgreenFinal.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 2000));
        await pageIgreenFinal.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 9999); }); await new Promise(r => setTimeout(r, 1500));
        await pageIgreenFinal.evaluate((cpfBusca) => { const linhas = Array.from(document.querySelectorAll('tr, [role="row"], div[class*="MuiDataGrid-row"]')); const linhaExata = linhas.find(row => row.textContent.replace(/\D/g, '').includes(cpfBusca)); if(linhaExata) { const btnTresPontinhos = Array.from(linhaExata.querySelectorAll('button, div')).find(el => el.textContent.trim() === '...'); if(btnTresPontinhos) btnTresPontinhos.click(); } }, cpf);
        await new Promise(r => setTimeout(r, 2000)); await pageIgreenFinal.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, li, div')).find(el => el.textContent.includes('Devolutivas')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 3000));
        for (let clique = 0; clique < 3; clique++) { await pageIgreenFinal.evaluate(() => { const botoesAcao = Array.from(document.querySelectorAll('button, span, a, div')).filter(el => el.textContent.trim() === 'Realizar ação' || el.textContent.includes('Realizar ação')); const btn = botoesAcao.filter(b => b.offsetParent !== null).pop() || botoesAcao[botoesAcao.length - 1]; if(btn) { btn.scrollIntoView({behavior: 'smooth', block: 'center'}); btn.click(); } }); await new Promise(r => setTimeout(r, 3000)); }
        const inputUploads = await pageIgreenFinal.$$('input[type="file"]');
        if (inputUploads.length > 0) { for (let input of inputUploads) { try { await input.uploadFile(caminhoFaturaLocal); await pageIgreenFinal.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input); } catch(e){} } } else { throw new Error("O formulário de anexo da iGreen está bloqueado ou invisível."); }
        await new Promise(r => setTimeout(r, 3000)); await pageIgreenFinal.evaluate(() => { const btnSalvar = Array.from(document.querySelectorAll('button')).find(el => el.textContent.toUpperCase().includes('ENVIAR') || el.textContent.toUpperCase().includes('SALVAR') || el.textContent.toUpperCase().includes('CONCLUIR')); if (btnSalvar) btnSalvar.click(); }); await new Promise(r => setTimeout(r, 5000)); 
        if (browserIgreen) await browserIgreen.close().catch(()=>{}); if (fs.existsSync(caminhoFaturaLocal)) fs.unlinkSync(caminhoFaturaLocal);
        if(!isAutomated) await enviarMensagem(phone, TEXTOS.T_RESGATE_SUCESSO);
    } catch (e) { 
        if (browserIgreen) await browserIgreen.close().catch(()=>{}); if (browserEquatorial) await browserEquatorial.close().catch(()=>{}); if (fs.existsSync(caminhoFaturaLocal)) fs.unlinkSync(caminhoFaturaLocal).catch(()=>{});
        if(!isAutomated) {
            if (e.message === "ERRO_LOGIN_IGREEN") { await enviarMensagem(phone, "⚠️ *Falha na iGreen*"); } 
            else if (e.message === "LINHA_CLIENTE_NAO_ENCONTRADA") { await enviarMensagem(phone, "⚠️ *Cliente Não Encontrado*"); } 
            else if (e.message === "FALTAM_DADOS_ESSENCIAIS") { await enviarMensagem(phone, "⚠️ *Dados Incompletos*"); } 
            else { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA_DEVOLUTIVA_MANUAL', cpfAlvo: cpf }); await enviarMensagem(phone, TEXTOS.T_FALHA_EQUATORIAL_PEDE_FATURA); }
        }
    }
}

function iniciarMotorRecorrente() {
    setInterval(async () => {
        await varreduraIgreenDiaria();
        if (admin.apps.length > 0) {
            try {
                const snapshot = await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').where('STATUS_CADASTRO', '==', 'PENDENTE_MEDIA').get();
                snapshot.forEach(async (doc) => {
                    const lead = doc.data(); const ultimaVerificacao = lead.DATA_ULTIMA_ATUALIZACAO ? lead.DATA_ULTIMA_ATUALIZACAO.toDate() : new Date();
                    const diasPassados = Math.floor((new Date() - ultimaVerificacao) / (1000 * 60 * 60 * 24));
                    if (diasPassados >= 15) { fluxoResgateDevolutiva(lead.NOME_CLIENTE, lead.TELEFONE_REMETENTE, lead.CPF, lead.DATA_NASCIMENTO, true); await salvarNoBanco(doc.id, lead.TELEFONE_REMETENTE, { STATUS_CADASTRO: 'PENDENTE_MEDIA' }); }
                });
            } catch (e) { console.error("Erro no Cron:", e.message); }
        }
    }, 86400000); 
    setTimeout(() => { varreduraIgreenDiaria(); }, 15000);
}
iniciarMotorRecorrente();

app.post('/webhook/igreen', async (req, res) => {
    res.status(200).send("OK"); const data = req.body; if (data.fromMe) return;
    const phone = data.phone; const textoIn = data.text?.message?.trim() || ""; const txtL = textoIn.toLowerCase();
    const temMidia = !!(data.image?.imageUrl || data.document?.documentUrl); const mediaUrl = data.image?.imageUrl || data.document?.documentUrl; const mimeType = data.document ? 'application/pdf' : 'image/jpeg';
    if (['0', 'cancelar', 'menu'].includes(txtL)) { memoriaEstado.set(phone, { STATUS_CADASTRO: 'NOVO' }); await enviarMensagem(phone, "🔄 Operação cancelada.\n\n" + TEXTOS.T_MENU); return; }
    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };
    if (mem.STATUS_CADASTRO === 'NOVO') {
        if (txtL === '1') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA_FLUXO_UNIVERSAL' }); await enviarMensagem(phone, TEXTOS.T01); return; }
        if (txtL === '2') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA_SOH_BANCO' }); await enviarMensagem(phone, TEXTOS.T_GUARDAR_START); return; }
        if (txtL === '3') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DADOS_DEVOLUTIVA' }); await enviarMensagem(phone, TEXTOS.T_RESGATE_START); return; }
        if (txtL === '4') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_UC_DOC' }); await enviarMensagem(phone, TEXTOS.T_START_OPCAO_4); return; }
        await enviarMensagem(phone, TEXTOS.T_MENU); return;
    }
    switch (mem.STATUS_CADASTRO) {
        case 'AGUARDANDO_FATURA_FLUXO_UNIVERSAL': { if (temMidia) { memoriaEstado.delete(phone); fluxoProcessamentoUniversal(mediaUrl, mimeType, phone); } else { await enviarMensagem(phone, "⚠️ Aguardando foto/PDF da fatura."); } break; }
        case 'AGUARDANDO_FATURA_DEVOLUTIVA_MANUAL': { if (temMidia) { const cpfAlvo = mem.cpfAlvo; memoriaEstado.delete(phone); fluxoProcessamentoUniversal(mediaUrl, mimeType, phone, cpfAlvo); } else { await enviarMensagem(phone, "⚠️ Envie a fatura."); } break; }
        case 'AGUARDANDO_FATURA_SOH_BANCO': { if (temMidia) { await enviarMensagem(phone, TEXTOS.T_GUARDAR_START); try { const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType); const docId = dadosIA.UC ? dadosIA.UC.replace(/\D/g, '') : `SEM_UC_${Date.now()}`; await salvarNoBanco(docId, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "AGUARDANDO_TELEFONE" }); memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TELEFONE', docId }); await enviarMensagem(phone, TEXTOS.T_PEDIR_TELEFONE.replace('${nome}', dadosIA.NOME_CLIENTE).replace('${uc}', dadosIA.UC)); } catch (e) { await enviarMensagem(phone, "❌ Erro na análise."); } } else { await enviarMensagem(phone, "⚠️ Aguardando fatura."); } break; }
        case 'AGUARDANDO_TELEFONE': { if (textoIn.length >= 8) { await salvarNoBanco(mem.docId, phone, { TELEFONE: textoIn, STATUS_CADASTRO: "AGUARDANDO_EMAIL" }); memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_EMAIL', docId: mem.docId }); await enviarMensagem(phone, TEXTOS.T_PEDIR_EMAIL); } else { await enviarMensagem(phone, "⚠️ Digite um telefone válido."); } break; }
        case 'AGUARDANDO_EMAIL': { if (textoIn.includes('@')) { await salvarNoBanco(mem.docId, phone, { EMAIL: textoIn, STATUS_CADASTRO: "PENDENTE_DOCUMENTOS" }); await enviarMensagem(phone, TEXTOS.T_FIM_PRE_CADASTRO); memoriaEstado.delete(phone); } else { await enviarMensagem(phone, "⚠️ Digite um e-mail."); } break; }
        case 'AGUARDANDO_DADOS_DEVOLUTIVA': { if (textoIn.length >= 3) { await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO); memoriaEstado.delete(phone); setTimeout(() => { fluxoResgateDevolutiva(textoIn, phone, null, null, false); }, 2000); } else { await enviarMensagem(phone, "⚠️ Digite o Nome/ID."); } break; }
        case 'AGUARDANDO_UC_DOC': { if (textoIn.length >= 4) { const ucLimpa = textoIn.replace(/\D/g, ''); const leadExistente = await buscarNoBanco(ucLimpa); if (leadExistente) { if (!leadExistente.TELEFONE) { memoriaEstado.set(phone, { STATUS_CADASTRO: 'OP4_PEDIR_TELEFONE', docId: ucLimpa }); await enviarMensagem(phone, TEXTOS.T_OP4_FALTANDO_TEL); } else if (!leadExistente.EMAIL) { memoriaEstado.set(phone, { STATUS_CADASTRO: 'OP4_PEDIR_EMAIL', docId: ucLimpa }); await enviarMensagem(phone, TEXTOS.T_OP4_FALTANDO_MAIL); } else { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: ucLimpa }); await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE); } } else { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: ucLimpa }); await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE); } } else { await enviarMensagem(phone, "⚠️ Digite a UC."); } break; }
        case 'OP4_PEDIR_TELEFONE': { if (textoIn.length >= 8) { await salvarNoBanco(mem.docId, phone, { TELEFONE: textoIn }); const leadAtualizadoTel = await buscarNoBanco(mem.docId); if (leadAtualizadoTel && !leadAtualizadoTel.EMAIL) {    
