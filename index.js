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
const IGREEN_REDE_URL = "https://escritorio.igreenenergy.com.br/mapa-rede";

const IGREEN_USER = process.env.IGREEN_USER;
const IGREEN_PASS = process.env.IGREEN_PASS;
const APP_ID = 'igreen-autoflow-v4';

const PROXY_IP = process.env.PROXY_IP;
const PROXY_PORT = process.env.PROXY_PORT;
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASS = process.env.PROXY_PASS;

// 🔥 CONEXÃO DB
try {
    const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
    if (firebaseConfig && admin.apps.length === 0) {
        admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
        console.log("✅ Banco de Dados Cloud ligado!");
    }
} catch (e) { console.error("Erro DB:", e.message); }

const memoriaEstado = new Map();

const TEXTOS = {
    T_MENU: "👋 Olá! Bem-vindo ao *Atendimento Inteligente iGreen*. \n\nEscolha uma opção:\n1️⃣ Enviar Fatura\n2️⃣ Pré-Cadastro\n3️⃣ Resolver Devolutiva\n4️⃣ Enviar Documentos",
    T_RESGATE_SUCESSO: "✅ Sucesso! Fatura resgatada e anexada na iGreen.",
    T_FALHA_EQUATORIAL_PEDE_FATURA: "⚠️ Distribuidora inacessível. Por favor, envie a fatura manualmente aqui."
};

const CHROME_ARGS = [
    "--no-sandbox", 
    "--disable-setuid-sandbox", 
    "--disable-dev-shm-usage", 
    "--disable-gpu", 
    "--no-zygote", 
    "--ignore-certificate-errors"
];

async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { 
        await axios.post(
            `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
            { phone: numLimpo, message: String(message) }, 
            { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' } }
        ); 
    } catch (e) {}
}

async function salvarNoBanco(docId, phone, dadosExtras) {
    if (admin.apps.length > 0) {
        try {
            const dadosLimpos = Object.fromEntries(
                Object.entries(dadosExtras).filter(([_, v]) => v !== "" && v !== null && v !== undefined && v !== "-")
            ); 
            await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(docId).set({ 
                ...dadosLimpos, 
                DATA_ULTIMA_ATUALIZACAO: admin.firestore.FieldValue.serverTimestamp() 
            }, { merge: true });
        } catch (e) { console.error("Erro Firebase:", e.message); }
    }
}

async function analisarFaturaGemini(mediaUrl, mimeType) {
    try {
        const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
        if (!response.data || response.data.length === 0) throw new Error("Ficheiro vazio.");
        const base64Data = Buffer.from(response.data, 'binary').toString('base64');
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const promptText = `Extraia os dados desta fatura de energia em formato JSON. Chaves: "NOME_CLIENTE", "CPF", "MASCARA_CPF", "DATA_NASCIMENTO", "UC", "CONTA_MES", "VENCIMENTO", "VALOR_FATURA", "CEP", "ENDERECO", "ENDERECO_NUMERO", "ENDERECO_COMPLEMENTO", "ESTADO", "DISTRIBUIDORA", "MEDIA_CONSUMO". Retorne string vazia se não encontrar.`;
        const payload = { 
            contents: [{ parts: [ { text: promptText }, { inline_data: { mime_type: mimeType === 'application/pdf' ? 'application/pdf' : 'image/jpeg', data: base64Data } } ] }], 
            generationConfig: { responseMimeType: "application/json" } 
        };
        const result = await axios.post(geminiUrl, payload, { headers: { 'Content-Type': 'application/json' } });
        return JSON.parse(result.data.candidates[0].content.parts[0].text);
    } catch (error) { throw new Error("Falha ao ler fatura."); }
}

// 🔥 VARREDURA DO IMPÉRIO (ASPIRADOR GLOBAL)
async function varreduraIgreenDiaria() {
    let browserIgreen = null;
    try {
        console.log(`\n[VARREDURA DIÁRIA] 🕵️ Iniciando Motor Aspirador Global...`);
        browserIgreen = await puppeteer.launch({ headless: true, args: CHROME_ARGS, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() });
        const pageIgreen = await browserIgreen.newPage(); 
        await pageIgreen.setViewport({ width: 1920, height: 1080 });
        
        await pageIgreen.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        try { 
            await pageIgreen.evaluate(() => { 
                const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); 
                if(btn) btn.click(); 
            }); 
            await new Promise(r => setTimeout(r, 2000)); 
        } catch(e){}
        
        await pageIgreen.waitForSelector('input[type="email"]');
        await pageIgreen.type('input[type="email"]', IGREEN_USER);
        await pageIgreen.type('input[type="password"]', IGREEN_PASS);
        await pageIgreen.evaluate(() => { 
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar')); 
            if (btn) btn.click(); 
        });
        await new Promise(r => setTimeout(r, 8000));

        // 🔥 FASE 1: MAPA DE REDE
        console.log(`[VARREDURA DIÁRIA] Acessando Mapa de Rede...`);
        await pageIgreen.goto(IGREEN_REDE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));
        await pageIgreen.evaluate(() => { document.body.style.zoom = "0.5"; }); 

        let licenciadosDaRede = await pageIgreen.evaluate(() => {
            let idsEncontrados = [];
            document.querySelectorAll('.MuiDataGrid-cell').forEach(cell => {
                const val = cell.textContent.trim();
                if (/^\d{4,6}$/.test(val)) idsEncontrados.push(val);
            });
            return [...new Set(idsEncontrados)]; 
        });

        if (!licenciadosDaRede || licenciadosDaRede.length === 0) licenciadosDaRede = ['76049'];
        console.log(`[VARREDURA DIÁRIA] Licenciados Ativos na Rede: ${licenciadosDaRede.join(', ')}`);

        // 🔥 FASE 2: MAPA DE CLIENTES GLOBAL
        console.log(`[VARREDURA DIÁRIA] Acessando Mapa de Clientes Global...`);
        await pageIgreen.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));
        await pageIgreen.evaluate(() => { document.body.style.zoom = "0.5"; }); 
        
        await pageIgreen.evaluate(() => {
            const input = document.querySelector('input[placeholder*="Buscar"]');
            if (input) {
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        await new Promise(r => setTimeout(r, 4000));
        
        let todosClientes = new Map();

        const horizontalScrolls = [0, 500, 1000, 1500, 2000, 0];
        for (let h of horizontalScrolls) {
            await pageIgreen.evaluate((p) => {
                const s = document.querySelector('.MuiDataGrid-virtualScroller');
                if(s) { s.scrollLeft = p; s.dispatchEvent(new Event('scroll')); }
            }, h);
            await new Promise(r => setTimeout(r, 500));
        }

        console.log(`[VARREDURA DIÁRIA] Iniciando Pente Fino Vertical...`);
        
        for (let pos = 0; pos <= 30000; pos += 400) {
            await pageIgreen.evaluate((p) => { 
                const s = document.querySelector('.MuiDataGrid-virtualScroller'); 
                if(s) { s.scrollTop = p; s.dispatchEvent(new Event('scroll')); } 
            }, pos);
            
            await new Promise(r => setTimeout(r, 600));

            let extraidosParciais = await pageIgreen.evaluate(() => {
                let m = {};
                const headers = Array.from(document.querySelectorAll('.MuiDataGrid-columnHeader'));
                let mapaColunas = { codigo: null, nome: null, celular: null, instalacao: null, distribuidora: null, dono_rede: null };
                
                headers.forEach(h => {
                    const texto = h.textContent.trim().toLowerCase();
                    const field = h.getAttribute('data-field');
                    
                    if ((texto === 'código' || texto === 'codigo' || texto === 'cód') && !texto.includes('licenciado')) mapaColunas.codigo = field;
                    if (texto.includes('código licencia') || texto.includes('codigo licencia') || texto.includes('licenciado')) mapaColunas.dono_rede = field;
                    if (texto === 'nome' || texto === 'cliente' || texto.includes('nome do cliente')) mapaColunas.nome = field;
                    if (texto === 'celular' || texto === 'telefone') mapaColunas.celular = field;
                    if (texto.includes('instala')) mapaColunas.instalacao = field;
                    if (texto.includes('distribuidora')) mapaColunas.distribuidora = field;
                });

                document.querySelectorAll('.MuiDataGrid-row').forEach(row => {
                    const id = row.getAttribute('data-id'); if(!id) return;
                    let textoTotal = row.textContent;
                    let cpf = textoTotal.match(/\d{3}\.\d{3}\.\d{3}-\d{2}/)?.[0]?.replace(/\D/g, '');
                    
                    let nasc = null;
                    const todasDatas = textoTotal.match(/\d{2}\/\d{2}\/\d{4}/g);
                    if (todasDatas && todasDatas.length > 0) {
                        let menorAno = 9999; for (let d of todasDatas) { let ano = parseInt(d.split('/')[2], 10); if (ano < menorAno) { menorAno = ano; nasc = d; } } if (menorAno > 2015) nasc = null;
                    }

                    let codigo = mapaColunas.codigo ? row.querySelector(`[data-field="${mapaColunas.codigo}"]`)?.textContent?.trim() : "";
                    let nome = mapaColunas.nome ? row.querySelector(`[data-field="${mapaColunas.nome}"]`)?.textContent?.trim() : "";
                    let tel = mapaColunas.celular ? row.querySelector(`[data-field="${mapaColunas.celular}"]`)?.textContent?.trim() : "";
                    let uc = mapaColunas.instalacao ? row.querySelector(`[data-field="${mapaColunas.instalacao}"]`)?.textContent?.trim() : "";
                    let dist = mapaColunas.distribuidora ? row.querySelector(`[data-field="${mapaColunas.distribuidora}"]`)?.textContent?.trim() : "";
                    let dono_bruto = mapaColunas.dono_rede ? row.querySelector(`[data-field="${mapaColunas.dono_rede}"]`)?.textContent?.trim() : "";
                    
                    if (!tel || tel.length < 8) tel = textoTotal.match(/\(?\d{2}\)?\s?\d{4,5}-?\d{4}/)?.[0] || "";
                    if (!uc || uc.length < 5) uc = textoTotal.match(/\b\d{8,12}\b/)?.[0] || "";
                    if (!dist) { const dists = ["EQUATORIAL", "ENEL", "COELBA", "CPFL", "CEMIG", "COPEL", "CELESC", "RGE", "EDP", "ENERGISA", "LIGHT"]; dist = dists.find(d => textoTotal.toUpperCase().includes(d)) || ""; }

                    if(tel) tel = tel.replace(/[^\d()-\s]/g, '').trim();
                    if(uc) uc = uc.replace(/\D/g, '').trim();
                    
                    let dono_rede = "";
                    if(dono_bruto) {
                        const dono_match = dono_bruto.replace(/\./g, '').match(/\b\d{4,6}\b/);
                        if (dono_match) dono_rede = dono_match[0];
                    }

                    let uniqueKey = codigo || uc || cpf;
                    if (uniqueKey) m[uniqueKey] = { cpf, nasc, codigo, nome, tel, uc, dist, dono_rede };
                });
                return m;
            });

            for (let uniqueKey in extraidosParciais) {
                const extraido = extraidosParciais[uniqueKey];
                let existente = todosClientes.get(uniqueKey) || {};
                todosClientes.set(uniqueKey, {
                    CODIGO_CLIENTE: extraido.codigo || existente.CODIGO_CLIENTE || "", 
                    NOME_CLIENTE: extraido.nome || existente.NOME_CLIENTE || "", 
                    CPF: extraido.cpf, DATA_NASCIMENTO: extraido.nasc || existente.DATA_NASCIMENTO || "", 
                    TELEFONE: extraido.tel || existente.TELEFONE || "", UC: extraido.uc || existente.UC || "", 
                    DISTRIBUIDORA: extraido.dist || existente.DISTRIBUIDORA || "",
                    DONO_REDE: extraido.dono_rede || existente.DONO_REDE || ""
                });
            }
        }

        const arrayClientes = Array.from(todosClientes.values());
        console.log(`[VARREDURA DIÁRIA] Pente Fino Concluído! ${arrayClientes.length} propriedades capturadas.`);
        
        for (let cli of arrayClientes) {
            let finalId = cli.CODIGO_CLIENTE || cli.UC || cli.CPF;
            let dbData = {};

            if (admin.apps.length > 0) {
                try {
                    let snap;
                    if (cli.CODIGO_CLIENTE) { snap = await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').where('CODIGO_CLIENTE', '==', cli.CODIGO_CLIENTE).get(); }
                    if ((!snap || snap.empty) && cli.UC) { snap = await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').where('UC', '==', cli.UC).get(); }
                    if(snap && !snap.empty) { finalId = snap.docs[0].id; dbData = snap.docs[0].data(); }
                } catch(e) {}
            }

            const payload = { NOME_CLIENTE: cli.NOME_CLIENTE, CPF: cli.CPF };
            
            if (cli.CODIGO_CLIENTE && cli.CODIGO_CLIENTE !== "76.049" && cli.CODIGO_CLIENTE !== "76049") { 
                payload.CODIGO_CLIENTE = cli.CODIGO_CLIENTE; 
            }

            if (cli.DATA_NASCIMENTO) payload.DATA_NASCIMENTO = cli.DATA_NASCIMENTO;
            if (cli.TELEFONE && cli.TELEFONE.length >= 8 && (!dbData.TELEFONE || dbData.TELEFONE.length < 8)) payload.TELEFONE = cli.TELEFONE;
            if (cli.UC && cli.UC.length >= 4 && (!dbData.UC || dbData.UC.length < 4)) payload.UC = cli.UC;
            if (cli.DISTRIBUIDORA && cli.DISTRIBUIDORA.length > 2 && (!dbData.DISTRIBUIDORA || dbData.DISTRIBUIDORA.length < 2)) payload.DISTRIBUIDORA = cli.DISTRIBUIDORA;
            
            if (cli.DONO_REDE) payload.DONO_REDE = cli.DONO_REDE;
            else if (!dbData.DONO_REDE) payload.DONO_REDE = '76049';

            if (dbData.STATUS_CADASTRO === 'INATIVO') { payload.STATUS_CADASTRO = "ATUALIZADO"; }
            else if (!dbData.STATUS_CADASTRO) { payload.STATUS_CADASTRO = "NOVO"; }

            await salvarNoBanco(finalId, "SISTEMA_VARREDURA", payload);
        }

        if (admin.apps.length > 0 && arrayClientes.length > 0) {
            try {
                const codigosAtivos = new Set(arrayClientes.map(c => c.CODIGO_CLIENTE).filter(c => c));
                const ucsAtivas = new Set(arrayClientes.map(c => c.UC).filter(c => c));

                const leadsSnapshot = await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').get();
                
                leadsSnapshot.forEach(async (doc) => {
                    const dbLead = doc.data();
                    
                    if (dbLead.CODIGO_CLIENTE && dbLead.CODIGO_CLIENTE !== '76.049') {
                        const sumiuPorCodigo = !codigosAtivos.has(dbLead.CODIGO_CLIENTE);
                        const sumiuPorUc = dbLead.UC ? !ucsAtivas.has(dbLead.UC) : true;
                        
                        if (sumiuPorCodigo && sumiuPorUc && dbLead.STATUS_CADASTRO !== 'INATIVO') {
                            console.log(`[AUDITORIA] Cliente sumiu da iGreen, movendo para INATIVO: ${dbLead.NOME_CLIENTE}`);
                            await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(doc.id).set({ STATUS_CADASTRO: 'INATIVO' }, { merge: true });
                        }
                    }
                });
            } catch(e) { console.error("Erro na Auditoria de Inativos:", e.message); }
        }

        console.log(`[VARREDURA DIÁRIA] ✅ Sistema Multi-Nível Sincronizado!\n`);
    } catch (e) { console.error("Erro Varredura:", e.message); } finally { if (browserIgreen) await browserIgreen.close(); }
}

async function fluxoProcessamentoUniversal(mediaUrl, mimeType, phone, cpfAlvo = null) {
    const localPath = path.join('/tmp', `fatura_universal_${Date.now()}.pdf`);
    let browserIgreen = null;
    try {
        await enviarMensagem(phone, "📥 *Iniciando Fluxo Universal...*\n\n🤖 1️⃣ Analisando a fatura com Inteligência Artificial...");
        let dadosIA; try { dadosIA = await analisarFaturaGemini(mediaUrl, mimeType); } catch (e) { await enviarMensagem(phone, "⚠️ A Inteligência Artificial teve dificuldade em ler o arquivo."); return; }
        const ucLimpa = dadosIA.UC ? String(dadosIA.UC).replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
        const cpfFatura = dadosIA.CPF ? String(dadosIA.CPF).replace(/\D/g, '') : null; const cpfFinal = cpfFatura || cpfAlvo; 
        await enviarMensagem(phone, `🔍 2️⃣ Verificando no nosso Banco de Dados Oficial...`);
        await salvarNoBanco(ucLimpa, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "PROCESSADO_UNIVERSAL" }); await new Promise(r => setTimeout(r, 1500));
        if (!cpfFinal) { await enviarMensagem(phone, "⚠️ CPF não identificado na fatura. Salvo no banco, mas injeção na iGreen abortada."); return; }
        await enviarMensagem(phone, `🚀 3️⃣ Baixando o PDF e voando para o portal da iGreen...`);
        const response = await axios({ url: mediaUrl, method: 'GET', responseType: 'stream' }); const writer = fs.createWriteStream(localPath); response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        browserIgreen = await puppeteer.launch({ headless: true, args: CHROME_ARGS, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() });
        const pageIgreen = await browserIgreen.newPage(); await pageIgreen.setViewport({ width: 1920, height: 1080 });
        await pageIgreen.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        try { 
            await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); 
            await new Promise(r => setTimeout(r, 2000)); 
        } catch(e){}
        await pageIgreen.waitForSelector('input[type="email"]', { timeout: 15000 }); 
        await pageIgreen.type('input[type="email"]', IGREEN_USER, { delay: 50 }); 
        await pageIgreen.type('input[type="password"]', IGREEN_PASS, { delay: 50 });
        await pageIgreen.evaluate(() => { const btnEntrar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent.toLowerCase().includes('acessar')); if (btnEntrar) btnEntrar.click(); });
        await Promise.race([ pageIgreen.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }), new Promise(resolve => setTimeout(resolve, 10000)) ]);
        try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
        await pageIgreen.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 }); await new Promise(r => setTimeout(r, 5000)); await pageIgreen.evaluate(() => { document.body.style.zoom = "0.4"; });
        
        let searchInput = await pageIgreen.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 });
        await searchInput.click({ clickCount: 3 }); await pageIgreen.keyboard.press('Backspace'); 
        await searchInput.type(cpfFinal, { delay: 100 }); await pageIgreen.keyboard.press('Enter'); 
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
        
        if (!clicouPontinhos) throw new Error("CLIENTE_NAO_ENCONTRADO_MAPA");
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
                try { await input.uploadFile(localPath); await pageIgreen.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input); } catch(e){} 
            } 
        } else { throw new Error("O formulário de anexo da iGreen está bloqueado ou invisível."); }
        
        await new Promise(r => setTimeout(r, 3000)); 
        await pageIgreen.evaluate(() => { const btnSalvar = Array.from(document.querySelectorAll('button')).find(el => el.textContent.toUpperCase().includes('ENVIAR') || el.textContent.toUpperCase().includes('SALVAR') || el.textContent.toUpperCase().includes('CONCLUIR')); if (btnSalvar) btnSalvar.click(); }); 
        await new Promise(r => setTimeout(r, 5000));
        
        await enviarMensagem(phone, "🎉 *Fim do Processo Universal!*\n\n1️⃣ Banco de Dados Sincronizado 💾\n2️⃣ Fatura Anexada na iGreen 🌿\n\nA operação foi um Sucesso Absoluto!");
    } catch (e) {
        if (e.message === "CLIENTE_NAO_ENCONTRADO_MAPA") { await enviarMensagem(phone, "✅ A fatura foi guardada no *Nosso Banco de Dados*!\n\n⚠️ Contudo, o robô não anexou na iGreen porque este cliente ainda não aparece no seu Mapa de Clientes do escritório virtual."); } 
        else { await enviarMensagem(phone, "⚠️ A fatura foi salva no nosso Banco, mas ocorreu um erro ao tentar anexar na iGreen."); }
    } finally { if (browserIgreen) await browserIgreen.close().catch(()=>{}); if (fs.existsSync(localPath)) fs.unlinkSync(localPath).catch(()=>{}); }
}

async function fluxoResgateDevolutiva(termoBuscaIgreen, phone, cpfBanco = null, nascBanco = null, isAutomated = false) {
    let browserIgreen = null; let browserEquatorial = null; const caminhoFaturaLocal = path.join('/tmp', `fatura_${Date.now()}.pdf`); let cpf = cpfBanco; let nascimento = nascBanco; let pdfCapturado = false;
    try {
        browserIgreen = await puppeteer.launch({ headless: true, args: CHROME_ARGS, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() }); 
        const pageIgreen = await browserIgreen.newPage(); 
        await pageIgreen.setViewport({ width: 1920, height: 1080 }); 
        
        if (!cpf || !nascimento) {
            await pageIgreen.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 }); 
            try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
            await pageIgreen.waitForSelector('input[type="email"]'); 
            await pageIgreen.type('input[type="email"]', IGREEN_USER, { delay: 50 }); 
            await pageIgreen.type('input[type="password"]', IGREEN_PASS, { delay: 50 });
            await pageIgreen.evaluate(() => { const btnEntrar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar') || b.textContent.toLowerCase().includes('acessar')); if (btnEntrar) btnEntrar.click(); });
            await Promise.race([ pageIgreen.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }), new Promise(resolve => setTimeout(resolve, 10000)) ]); 
            if (pageIgreen.url().includes('login')) throw new Error("ERRO_LOGIN_IGREEN");
            try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
            
            await pageIgreen.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 }); 
            await new Promise(r => setTimeout(r, 5000)); 
            await pageIgreen.evaluate(() => { document.body.style.zoom = "0.4"; });
            
            let searchInput; try { searchInput = await pageIgreen.waitForSelector('input[placeholder*="Buscar"]', { timeout: 15000 }); } catch (e) { throw new Error("LINHA_CLIENTE_NAO_ENCONTRADA"); }
            await searchInput.click(); await searchInput.click({ clickCount: 3 }); await pageIgreen.keyboard.press('Backspace'); 
            await searchInput.type(termoBuscaIgreen, { delay: 100 }); await pageIgreen.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 3000));
            
            await pageIgreen.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 0); }); await new Promise(r => setTimeout(r, 1500));
            let extraidosEsq = await pageIgreen.evaluate((busca) => { const linhas = Array.from(document.querySelectorAll('tr, [role="row"], .MuiDataGrid-row')); const l = linhas.find(x => x.textContent.toLowerCase().includes(busca.toLowerCase().trim())); if(!l) return { texto: "", codigo: "", nome: "" }; const cols = Array.from(l.querySelectorAll('.MuiDataGrid-cell, td')); return { texto: l.textContent, codigo: cols[0]?.textContent?.trim() || "", nome: cols[1]?.textContent?.trim() || "" }; }, termoBuscaIgreen);
            await pageIgreen.evaluate(() => { const scrollers = document.querySelectorAll('.MuiDataGrid-virtualScroller'); scrollers.forEach(s => s.scrollLeft = 9999); }); await new Promise(r => setTimeout(r, 1500));
            
            const dadosExtraidos = await pageIgreen.evaluate((busca, esqTexto) => { 
                const linhas = Array.from(document.querySelectorAll('tr, [role="row"], .MuiDataGrid-row')); 
                let linhaExata = linhas.find(l => l.textContent.toLowerCase().includes(busca.toLowerCase().trim())); 
                if (!linhaExata && linhas.length > 1) linhaExata = linhas[1]; 
                let textoCompleto = esqTexto + "   " + (linhaExata ? linhaExata.textContent : ""); 
                let cpfExt = null; let nascExt = null; 
                const cpfMatch = textoCompleto.match(/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/); 
                if (cpfMatch) cpfExt = cpfMatch[0].replace(/\D/g, ''); 
                const todasDatas = textoCompleto.match(/\d{2}\/\d{2}\/\d{4}/g); 
                if (todasDatas && todasDatas.length > 0) { 
                    let menorAno = 9999; 
                    for (let d of todasDatas) { let ano = parseInt(d.split('/')[2], 10); if (ano < menorAno) { menorAno = ano; nascExt = d; } } 
                    if (menorAno > 2015) nascExt = null; 
                } 
                if (!cpfExt || !nascExt) return { falhouBusca: true }; 
                return { cpfExt, nascExt }; 
            }, termoBuscaIgreen, extraidosEsq.texto);
            
            if (dadosExtraidos && dadosExtraidos.falhouBusca) throw new Error("FALTAM_DADOS_ESSENCIAIS");
            cpf = dadosExtraidos.cpfExt; nascimento = dadosExtraidos.nascExt;
            await salvarNoBanco(cpf, phone, { CODIGO_CLIENTE: extraidosEsq.codigo, CPF: cpf, DATA_NASCIMENTO: nascimento, NOME_CLIENTE: extraidosEsq.nome || termoBuscaIgreen });
        }
        
        for (let tentativa = 1; tentativa <= 3; tentativa++) {
            let proxyUrlForPuppeteer = null;
            try {
                let puppeteerArgsEq = [...CHROME_ARGS];
                if (PROXY_IP && PROXY_PORT && PROXY_USER && PROXY_PASS) { 
                    const rawProxyUrl = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_IP}:${PROXY_PORT}`; 
                    const proxyPromise = anonymizeProxy(rawProxyUrl); 
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout Proxy")), 20000)); 
                    proxyUrlForPuppeteer = await Promise.race([proxyPromise, timeoutPromise]); 
                    puppeteerArgsEq.push(`--proxy-server=${proxyUrlForPuppeteer}`); 
                } 
                browserEquatorial = await puppeteer.launch({ headless: true, args: puppeteerArgsEq, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(), defaultViewport: { width: 1920, height: 1080 } }); 
                const pageEq = await browserEquatorial.newPage(); 
                await pageEq.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); window.chrome = { runtime: {} }; });
                await pageEq.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
                await pageEq.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7', 'Upgrade-Insecure-Requests': '1', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8' });
                
                const clientEq = await pageEq.target().createCDPSession(); 
                await clientEq.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' });
                
                const escutarPDF = async (response) => { 
                    try { 
                        const contentType = response.headers()['content-type']; 
                        const contentDisposition = response.headers()['content-disposition']; 
                        if (response.status() === 200 && ((contentType && contentType.includes('application/pdf')) || (contentDisposition && contentDisposition.includes('.pdf')))) { 
                            const buffer = await response.buffer(); fs.writeFileSync(caminhoFaturaLocal, buffer); 
                        } 
                    } catch(err) {} 
                };
                pageEq.on('response', escutarPDF); 
                browserEquatorial.on('targetcreated', async (target) => { if (target.type() === 'page') { try { const novaAba = await target.page(); novaAba.on('response', escutarPDF); } catch (e    
