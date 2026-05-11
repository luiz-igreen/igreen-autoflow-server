import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

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

try {
    const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
    if (firebaseConfig && admin.apps.length === 0) {
        admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
        console.log("✅ Banco de Dados Cloud ligado!");
    }
} catch (e) { console.error("Erro DB:", e.message); }

const memoriaEstado = new Map();

// ==========================================
// TEXTOS DA OPERAÇÃO
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
    
    T_RESGATE_START: "Opção 3️⃣ selecionada! ⚡ \nPara resolvermos a devolutiva, o robô vai buscar a UC, CPF e Nascimento no seu escritório, baixar a fatura na Distribuidora e anexar.\n\nPor favor, digite apenas o **Nome do Cliente ou ID**.\n\n*(Exemplo: 398172 ou Wellington Silva Nunes)*:",
    T_RESGATE_BUSCANDO: "🔍 Iniciando a Automação Total...\n\n1️⃣ Buscando CPF, Nascimento e UC no relatório da iGreen...\n2️⃣ Acessando a Distribuidora Local...\n3️⃣ Baixando fatura atualizada da UC...\n4️⃣ Retornando à iGreen para injetar o documento...\n\nIsso pode levar alguns segundos, aguarde...",
    T_RESGATE_SUCESSO: "✅ Sucesso Absoluto! A fatura atualizada foi resgatada e anexada na aba de Devolutivas do escritório iGreen. A sua pendência foi resolvida!",
    T_RESGATE_FAIL: "⚠️ Ocorreu um erro no processo. O robô pode ter sido bloqueado pelo site da iGreen temporariamente ou os dados não foram encontrados. Tentaremos novamente mais tarde.",

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
    "--window-size=1920,1080",
    "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
];

// ==========================================
// FUNÇÕES AUXILIARES
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

// ==========================================
// MÓDULO 1: MOTOR IA
// ==========================================
async function analisarFaturaGemini(mediaUrl, mimeType) {
    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    const base64Data = Buffer.from(response.data, 'binary').toString('base64');
    const instrucao = `Auditor iGreen. Regra Média: Soma últimos 6 meses (ou disponíveis) / quantidade de meses.`;
    const payload = {
        systemInstruction: { parts: [{ text: instrucao }] },
        contents: [{ parts: [{ text: "Extraia os dados organizadamente." }, { inlineData: { mimeType, data: base64Data } }] }],
        generationConfig: { 
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    "DISTRIBUIDORA": { type: "STRING" }, "NOME_CLIENTE": { type: "STRING" }, "MASCARA_CPF": { type: "STRING" }, "CPF": { type: "STRING" },
                    "ENDERECO": { type: "STRING" }, "ENDERECO_NUMERO": { type: "STRING" }, "ENDERECO_COMPLEMENTO": { type: "STRING" },
                    "BAIRRO": { type: "STRING" }, "CIDADE": { type: "STRING" }, "ESTADO": { type: "STRING" }, "CEP": { type: "STRING" },
                    "UC": { type: "STRING" }, "CONTA_MES": { type: "STRING" }, "VENCIMENTO": { type: "STRING" }, "VALOR_FATURA": { type: "STRING" }, "MEDIA_CONSUMO": { type: "STRING" }, "DATA_NASCIMENTO": { type: "STRING" }
                }
            }
        }
    };
    const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY.trim()}`, payload);
    return JSON.parse(res.data.candidates[0].content.parts[0].text);
}

// ==========================================
// MÓDULO 2: EXTRATOR RPA TOTAL (IGREEN -> EQUATORIAL -> IGREEN)
// ==========================================
async function fluxoResgateDevolutiva(termoBuscaIgreen, phone, cpfBanco = null, nascBanco = null, ucBanco = null, isAutomated = false) {
    let browser;
    const caminhoFaturaLocal = path.join('/tmp', `fatura_${Date.now()}.pdf`);
    let cpf = cpfBanco;
    let nascimento = nascBanco;
    let uc = ucBanco;

    try {
        browser = await puppeteer.launch({ 
            headless: true, 
            args: CHROME_ARGS,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() 
        });
        const page = await browser.newPage();
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        
        await page.setViewport({ width: 1920, height: 1080 });

        if (!cpf || !nascimento || !uc) {
            console.log(`[RPA] ETAPA 1: Buscando dados de ${termoBuscaIgreen} na iGreen...`);
            
            await page.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            console.log(`[RPA] Página de login carregada.`);
            
            try { await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
            
            await page.waitForSelector('input[type="email"]');
            
            await page.type('input[type="email"]', IGREEN_USER, { delay: 50 });
            await page.type('input[type="password"]', IGREEN_PASS, { delay: 50 });
            
            console.log(`[RPA] Clicando no botão de acesso...`);
            await page.evaluate(() => {
                const botoes = Array.from(document.querySelectorAll('button'));
                const btnEntrar = botoes.find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent.toLowerCase().includes('acessar') || b.textContent.toLowerCase().includes('login'));
                if (btnEntrar) btnEntrar.click();
            });
            
            await page.keyboard.press('Enter');
            console.log(`[RPA] Credenciais inseridas. Aguardando entrada...`);
            
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
                new Promise(resolve => setTimeout(resolve, 10000))
            ]);

            const urlAtualLogin = page.url();
            if (urlAtualLogin.includes('login') || urlAtualLogin.includes('entrar')) {
                throw new Error("O site da iGreen recusou o login. Verifique a senha ou pode ser bloqueio anti-robô.");
            }

            try { await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}

            console.log(`[RPA] Navegando para a página do mapa...`);
            await page.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 5000));

            console.log(`[RPA] Procurando a barra de Buscar...`);
            
            let searchInput;
            try {
                searchInput = await page.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 });
            } catch (erroSeletor) {
                console.log(`[RPA] ❌ ERRO CRÍTICO: Não encontrou a barra de Buscar.`);
                throw new Error("Página carregou, mas a barra de Buscar não existe.");
            }

            await searchInput.click();
            await new Promise(r => setTimeout(r, 500));
            
            await searchInput.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 500));

            await searchInput.type(termoBuscaIgreen, { delay: 100 }); 
            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('Enter');
            
            console.log(`[RPA] Busca digitada. Aguardando a tabela filtrar...`);
            
            try {
                await page.waitForFunction(
                    (busca) => document.body.innerText.toLowerCase().includes(busca.toLowerCase()),
                    { timeout: 12000 },
                    termoBuscaIgreen
                );
                console.log(`[RPA] O cliente apareceu na tela! Procedendo à extração...`);
            } catch (e) {
                console.log(`[RPA] Aviso: O texto não apareceu após 12s. O cliente pode não existir.`);
            }
            
            await new Promise(r => setTimeout(r, 2000));

            // ==========================================
            // O NOVO EXTRATOR UNIVERSAL DE GRIDS (O SEU MÉTODO DE COLUNAS)
            // ==========================================
            const dadosExtraidos = await page.evaluate((busca) => {
                const buscaLimpa = busca.toLowerCase().trim();

                // 1. Procurar os cabeçalhos de forma universal (th ou divs de grid)
                const cabecalhosNodos = Array.from(document.querySelectorAll('th, [role="columnheader"], div[class*="header"], .MuiDataGrid-columnHeaderTitle'));
                let idxDocumento = -1;
                let idxNascimento = -1;
                let idxInstalacao = -1;

                cabecalhosNodos.forEach((nodo, index) => {
                    const txt = nodo.textContent.trim().toLowerCase();
                    if (txt === 'documento' || txt.includes('documento')) idxDocumento = index;
                    if (txt === 'data nascimento' || txt.includes('nascimento')) idxNascimento = index;
                    if (txt === 'instalação' || txt.includes('instalacao')) idxInstalacao = index;
                });

                // 2. Encontrar a linha (Universal para Tabelas e React Grids)
                const possiveisLinhas = Array.from(document.querySelectorAll('tr, [role="row"], div[class*="MuiDataGrid-row"], div[class*="rt-tr"]'));
                
                // Pega só as linhas que têm algum conteúdo de verdade
                const linhasComDados = possiveisLinhas.filter(l => l.textContent.trim().length > 15);
                
                // Procura a linha que contém o ID do cliente
                const linhaExata = linhasComDados.find(linha => linha.textContent.toLowerCase().includes(buscaLimpa));
                
                if (!linhaExata) {
                    const txtTela = document.body.innerText.substring(0, 1000).replace(/\n/g, ' || ');
                    return { falhouBusca: true, debugVisao: `O grid não usou TR nem Role Row. Visão Parcial: ${txtTela}` };
                }

                // 3. Pegar as caixas/colunas dessa linha
                let colunas = Array.from(linhaExata.querySelectorAll('td, [role="cell"], div[class*="MuiDataGrid-cell"], div[class*="rt-td"]'));
                if (colunas.length === 0) {
                    colunas = Array.from(linhaExata.children); // Fallback para divs simples
                }

                let cpfExt = null;
                let nascExt = null;
                let ucExt = null;

                // MÉTODO A: O Seu Método Cirúrgico Pelos Índices dos Nomes
                if (idxDocumento !== -1 && colunas[idxDocumento]) cpfExt = colunas[idxDocumento].textContent.trim();
                if (idxNascimento !== -1 && colunas[idxNascimento]) nascExt = colunas[idxNascimento].textContent.trim();
                if (idxInstalacao !== -1 && colunas[idxInstalacao]) ucExt = colunas[idxInstalacao].textContent.replace(/\D/g, '');

                // MÉTODO B: Fallback de Inteligência Artificial (Caso a ordem das colunas falhe)
                const textoCompletoLinha = linhaExata.textContent;
                
                if (!cpfExt || cpfExt.length < 11) {
                    const cpfMatch = textoCompletoLinha.match(/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
                    if (cpfMatch) cpfExt = cpfMatch[0];
                }
                
                if (!nascExt || nascExt.length < 8) {
                    const datasMatch = textoCompletoLinha.match(/\d{2}\/\d{2}\/\d{4}/g);
                    if (datasMatch && datasMatch.length > 0) {
                        // Truque de Ouro: A Data de Nascimento é sempre o ano mais antigo da linha!
                        nascExt = datasMatch.reduce((maisAntiga, atual) => {
                            const anoAtual = parseInt(atual.split('/')[2], 10);
                            const anoMaisAntiga = parseInt(maisAntiga.split('/')[2], 10);
                            return anoAtual < anoMaisAntiga ? atual : maisAntiga;
                        });
                    }
                }

                if (!ucExt || ucExt.length < 5) {
                    const numerosGrandes = textoCompletoLinha.match(/\b\d{8,12}\b/g);
                    if (numerosGrandes) ucExt = numerosGrandes[0];
                }

                return { cpfExt, nascExt, ucExt };
            }, termoBuscaIgreen);

            if (dadosExtraidos && dadosExtraidos.falhouBusca) {
                console.log(`[RPA] 🔎 RAIO-X DA TABELA: ${dadosExtraidos.debugVisao}`);
                throw new Error(`O robô viu o cliente na tela, mas a estrutura do Grid é impenetrável.`);
            }

            if (!dadosExtraidos || !dadosExtraidos.cpfExt || !dadosExtraidos.nascExt || !dadosExtraidos.ucExt) {
                throw new Error(`Dados incompletos na tabela. O cliente pode não ter Data de Nascimento ou Documento preenchidos.`);
            }

            cpf = dadosExtraidos.cpfExt.replace(/\D/g, '');
            nascimento = dadosExtraidos.nascExt;
            uc = dadosExtraidos.ucExt;
            console.log(`[RPA] Sucesso Máximo na Etapa 1! CPF: ${cpf} | Nasc: ${nascimento} | UC: ${uc}`);
        }

        page.on('response', async (response) => {
            const contentType = response.headers()['content-type'];
            if (contentType && contentType.includes('application/pdf')) {
                const buffer = await response.buffer();
                fs.writeFileSync(caminhoFaturaLocal, buffer);
            }
        });

        console.log(`[RPA] ETAPA 2: Acessando Equatorial AL...`);
        await page.goto(EQUATORIAL_AL_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        try {
            await page.evaluate(() => {
                const check = document.querySelector('input[type="checkbox"]'); if(check) check.click();
                const btnEnviar = Array.from(document.querySelectorAll('button, div, span')).find(el => el.textContent.toUpperCase().includes('ENVIAR')); if(btnEnviar) btnEnviar.click();
                const btnFechar = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase().includes('FECHAR')); if(btnFechar) btnFechar.click();
            });
            await new Promise(r => setTimeout(r, 2000));
        } catch(e) {}

        await page.evaluate((cpfBusca, nascBusca) => {
            const inputs = document.querySelectorAll('input');
            inputs.forEach(input => {
                if (input.placeholder.toLowerCase().includes('cpf') || input.placeholder.toLowerCase().includes('cnpj')) input.value = cpfBusca;
                if (input.placeholder.toLowerCase().includes('nascimento') || input.placeholder.toLowerCase().includes('data')) input.value = nascBusca;
            });
            const btnEntrar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toUpperCase().includes('ENTRAR'));
            if(btnEntrar) btnEntrar.click();
        }, cpf, nascimento);
        await new Promise(r => setTimeout(r, 5000));

        await page.evaluate((alvoUc) => {
            const btnSair = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase().includes('SAIR'));
            if(btnSair) btnSair.click(); 
            const elemUc = Array.from(document.querySelectorAll('span, div, option, li, p')).find(el => el.textContent.includes(alvoUc));
            if(elemUc) elemUc.click();
        }, uc);
        await new Promise(r => setTimeout(r, 3000));

        await page.evaluate(() => {
            const btn2via = Array.from(document.querySelectorAll('span, a, div, button')).find(el => el.textContent.toLowerCase().includes('segunda via'));
            if(btn2via) btn2via.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        await page.evaluate(() => {
            const valorFatura = Array.from(document.querySelectorAll('span, td, div')).find(el => el.textContent.includes('R$'));
            if(valorFatura) valorFatura.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        await page.evaluate(() => {
            const btnVerFatura = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase().includes('VER FATURA'));
            if(btnVerFatura) btnVerFatura.click();
        });
        
        await new Promise(r => setTimeout(r, 8000)); 
        if (!fs.existsSync(caminhoFaturaLocal)) throw new Error("Falha ao capturar o PDF na Equatorial.");

        console.log(`[RPA] ETAPA 3: Injetando na iGreen...`);
        await page.goto("https://escritorio.igreenenergy.com.br", { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 4000));

        await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, div')).find(el => el.textContent.trim() === 'Clientes'); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 4000));

        await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, div, p')).find(el => el.textContent.trim() === 'Green'); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 4000));

        console.log(`[RPA] Procurando a barra de Buscar nas Devolutivas...`);
        const searchDevolutiva = await page.waitForSelector('input[placeholder*="Buscar"]');
        
        await searchDevolutiva.click();
        await new Promise(r => setTimeout(r, 500));
        await searchDevolutiva.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 500));
        
        await searchDevolutiva.type(cpf, { delay: 100 });
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');
        
        console.log(`[RPA] ENTER pressionado na Devolutiva. Aguardando a tabela filtrar...`);
        
        try {
            await page.waitForFunction(
                (busca) => document.body.innerText.includes(busca),
                { timeout: 10000 },
                cpf
            );
        } catch (e) {}
        
        await new Promise(r => setTimeout(r, 2000));

        // Aplicação do Grid Universal também nas Devolutivas
        await page.evaluate((alvoUc) => { 
            const linhas = Array.from(document.querySelectorAll('tr, [role="row"], div[class*="MuiDataGrid-row"], div[class*="rt-tr"]')); 
            const linhaExata = linhas.find(row => row.textContent.includes(alvoUc)); 
            if(linhaExata) {
                const btnTresPontinhos = Array.from(linhaExata.querySelectorAll('button, div')).find(el => el.textContent.trim() === '...'); 
                if(btnTresPontinhos) btnTresPontinhos.click(); 
            }
        }, uc);
        await new Promise(r => setTimeout(r, 2000));

        await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, li, div')).find(el => el.textContent.includes('Devolutivas')); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 3000));

        await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, span, div')).find(el => el.textContent.includes('Realizar ação')); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 3000));

        const [fileChooser] = await Promise.all([
            page.waitForFileChooser(),
            page.evaluate(() => { 
                const b = Array.from(document.querySelectorAll('*')).find(el => el.textContent.includes('Selecionar arquivo') || el.type === 'file'); 
                if (b) b.click(); 
            })
        ]);
        await fileChooser.accept([caminhoFaturaLocal]);
        await new Promise(r => setTimeout(r, 2000));

        await page.evaluate(() => { 
            const btnSalvar = Array.from(document.querySelectorAll('button')).find(el => el.textContent.toUpperCase().includes('ENVIAR') || el.textContent.toUpperCase().includes('SALVAR')); 
            if (btnSalvar) btnSalvar.click(); 
        });
        await new Promise(r => setTimeout(r, 4000));
        
        await browser.close();
        if(fs.existsSync(caminhoFaturaLocal)) fs.unlinkSync(caminhoFaturaLocal);

        if(!isAutomated) await enviarMensagem(phone, TEXTOS.T_RESGATE_SUCESSO);
        
    } catch (e) { 
        console.error("Erro RPA Devolutivas:", e.message);
        if(browser) await browser.close(); 
        if(fs.existsSync(caminhoFaturaLocal)) fs.unlinkSync(caminhoFaturaLocal);
        if(!isAutomated) await enviarMensagem(phone, TEXTOS.T_RESGATE_FAIL);
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
                        fluxoResgateDevolutiva(lead.NOME_CLIENTE, lead.TELEFONE_REMETENTE, lead.CPF, lead.DATA_NASCIMENTO, lead.UC, true);
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
                
                setTimeout(() => { fluxoResgateDevolutiva(textoIn, phone, null, null, null, false); }, 2000);
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
// HEALTH CHECK E INICIALIZAÇÃO
// ==========================================
const PORT = process.env.PORT || 10000;

async function validateBrowser() {
    try {
        console.log("⏳ Iniciando Health Check do Navegador (Modo Docker)...");
        const browser = await puppeteer.launch({
            headless: true,
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

// ROTA DE SEGURANÇA PARA O RENDER
app.get('/', (req, res) => res.status(200).send('Robô iGreen Online e Blindado!'));

validateBrowser().then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor rodando a 100% na porta ${PORT} via Docker (0.0.0.0)`));
});
