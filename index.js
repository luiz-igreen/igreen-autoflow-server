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

const CHROME_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--ignore-certificate-errors"];

async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numLimpo, message: String(message) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' } }); } catch (e) {}
}

async function salvarNoBanco(docId, phone, dadosExtras) {
    if (admin.apps.length > 0) {
        try {
            const dadosLimpos = Object.fromEntries(Object.entries(dadosExtras).filter(([_, v]) => v !== "" && v !== null && v !== undefined)); 
            await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(docId).set({ 
                ...dadosLimpos, 
                DATA_ULTIMA_ATUALIZACAO: admin.firestore.FieldValue.serverTimestamp() 
            }, { merge: true });
        } catch (e) { console.error("Erro Firebase:", e.message); }
    }
}

// 🔥 VARREDURA SNIPER: Mirando exatamente nas colunas 'Celular', 'Instalação' e 'Distribuidora'
async function varreduraIgreenDiaria() {
    let browserIgreen = null;
    try {
        console.log(`\n[VARREDURA DIÁRIA] 🕵️ Iniciando Colheita Sniper (76049)...`);
        browserIgreen = await puppeteer.launch({ headless: true, args: CHROME_ARGS, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath() });
        const pageIgreen = await browserIgreen.newPage(); 
        await pageIgreen.setViewport({ width: 1920, height: 1080 });
        
        await pageIgreen.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        try { await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}
        
        await pageIgreen.waitForSelector('input[type="email"]');
        await pageIgreen.type('input[type="email"]', IGREEN_USER);
        await pageIgreen.type('input[type="password"]', IGREEN_PASS);
        await pageIgreen.evaluate(() => { const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('entrar')); if (btn) btn.click(); });
        await new Promise(r => setTimeout(r, 8000));

        await pageIgreen.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));
        await pageIgreen.evaluate(() => { document.body.style.zoom = "0.5"; }); 

        // Filtrar exclusivamente pela sua rede 76049
        try {
            let searchInput = await pageIgreen.waitForSelector('input[placeholder*="Buscar"]', { timeout: 10000 });
            await searchInput.click({ clickCount: 3 }); await pageIgreen.keyboard.press('Backspace');
            await searchInput.type('76049'); await pageIgreen.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 6000));
        } catch(e) {}
        
        let todosClientes = new Map();

        // Rolar a tela 5 vezes para pegar todos os clientes
        for (let volta = 0; volta < 5; volta++) {
            
            // 1. LER LADO ESQUERDO (Código, Nome, CPF)
            await pageIgreen.evaluate(() => { const s = document.querySelector('.MuiDataGrid-virtualScroller'); if(s) s.scrollLeft = 0; });
            await new Promise(r => setTimeout(r, 1500));
            const dadosEsq = await pageIgreen.evaluate(() => {
                let m = {};
                document.querySelectorAll('.MuiDataGrid-row').forEach(row => {
                    const id = row.getAttribute('data-id'); if(!id) return;
                    const cols = Array.from(row.querySelectorAll('.MuiDataGrid-cell'));
                    m[id] = { 
                        codigo: cols[0]?.textContent?.trim(), 
                        nome: cols[1]?.textContent?.trim(), 
                        cpf: cols.find(c => c.textContent.match(/\d{3}\.\d{3}\.\d{3}-\d{2}/))?.textContent?.replace(/\D/g, '') 
                    };
                });
                return m;
            });

            // 2. LER LADO DIREITO (Data, Celular, Instalação, Distribuidora)
            await pageIgreen.evaluate(() => { const s = document.querySelector('.MuiDataGrid-virtualScroller'); if(s) s.scrollLeft = 9999; });
            await new Promise(r => setTimeout(r, 1500));
            const dadosDir = await pageIgreen.evaluate(() => {
                let m = {};
                document.querySelectorAll('.MuiDataGrid-row').forEach(row => {
                    const id = row.getAttribute('data-id'); if(!id) return;
                    const texto = row.textContent;
                    
                    // Extrair Nascimento
                    let nasc = null;
                    const todasDatas = texto.match(/\d{2}\/\d{2}\/\d{4}/g);
                    if (todasDatas && todasDatas.length > 0) {
                        let menorAno = 9999; for (let d of todasDatas) { let ano = parseInt(d.split('/')[2], 10); if (ano < menorAno) { menorAno = ano; nasc = d; } } if (menorAno > 2015) nasc = null;
                    }

                    // 🔥 BUSCA CIRÚRGICA PELAS COLUNAS EXATAS
                    const celCell = row.querySelector('[data-field*="elular"]');
                    const instCell = row.querySelector('[data-field*="nstala"]');
                    const distCell = row.querySelector('[data-field*="istribuidora"]');

                    let tel = celCell ? celCell.textContent.replace(/[^\d()-\s]/g, '').trim() : "";
                    let uc = instCell ? instCell.textContent.replace(/\D/g, '').trim() : "";
                    let dist = distCell ? distCell.textContent.trim() : "";

                    // Backups caso a iGreen mude o nome interno das colunas
                    if (!tel || tel.length < 8) tel = texto.match(/\(?\d{2}\)?\s?\d{4,5}-?\d{4}/)?.[0] || "";
                    if (!uc || uc.length < 5) uc = texto.match(/\b\d{8,12}\b/)?.[0] || "";
                    if (!dist) {
                        const dists = ["EQUATORIAL", "ENEL", "COELBA", "CPFL", "CEMIG", "COPEL", "CELESC", "RGE", "EDP", "ENERGISA", "LIGHT"];
                        dist = dists.find(d => texto.toUpperCase().includes(d)) || "";
                    }

                    m[id] = { nasc, tel, uc, dist };
                });
                return m;
            });

            // 3. FUNDIR DADOS DA PÁGINA
            for (let id in dadosEsq) {
                if (dadosEsq[id].cpf) {
                    const c = dadosEsq[id]; const d = dadosDir[id] || {};
                    todosClientes.set(c.cpf, {
                        CODIGO_CLIENTE: c.codigo, NOME_CLIENTE: c.nome, CPF: c.cpf,
                        DATA_NASCIMENTO: d.nasc, TELEFONE: d.tel, UC: d.uc, DISTRIBUIDORA: d.dist
                    });
                }
            }
            // DESCE A TELA
            await pageIgreen.evaluate(() => { const s = document.querySelector('.MuiDataGrid-virtualScroller'); if(s) s.scrollTop += 600; });
            await new Promise(r => setTimeout(r, 1500));
        }

        const arrayClientes = Array.from(todosClientes.values());
        console.log(`[VARREDURA DIÁRIA] Leitura concluída. Analisando ${arrayClientes.length} clientes...`);
        
        // 4. INJETAR NO BANCO DE DADOS (Com proteção de colunas existentes)
        for (let cli of arrayClientes) {
            let finalId = cli.CPF;
            let dbData = {};

            if (admin.apps.length > 0) {
                const snap = await admin.firestore().collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').where('CPF', '==', cli.CPF).get();
                if(!snap.empty) {
                    finalId = snap.docs[0].id;
                    dbData = snap.docs[0].data();
                }
            }

            const payload = {
                CODIGO_CLIENTE: cli.CODIGO_CLIENTE,
                NOME_CLIENTE: cli.NOME_CLIENTE,
                CPF: cli.CPF
            };
            
            // Só preenche se a informação existir na iGreen e estiver vazia no nosso Banco
            if (cli.DATA_NASCIMENTO) payload.DATA_NASCIMENTO = cli.DATA_NASCIMENTO;
            if (cli.TELEFONE && !dbData.TELEFONE) payload.TELEFONE = cli.TELEFONE;
            if (cli.UC && !dbData.UC) payload.UC = cli.UC;
            if (cli.DISTRIBUIDORA && !dbData.DISTRIBUIDORA) payload.DISTRIBUIDORA = cli.DISTRIBUIDORA;
            
            // Se for cliente 100% novo, ganha status NOVO. Se já existia, não mexemos no status!
            if (!dbData.STATUS_CADASTRO) payload.STATUS_CADASTRO = "NOVO";

            await salvarNoBanco(finalId, "SISTEMA_VARREDURA", payload);
        }
        console.log(`[VARREDURA DIÁRIA] ✅ Banco atualizado e colunas preenchidas com sucesso!\n`);
    } catch (e) { console.error("Erro Varredura:", e.message); } finally { if (browserIgreen) await browserIgreen.close(); }
}

// Inicia o motor a cada 24h, e 15 segundos após ligar a máquina
setInterval(() => { varreduraIgreenDiaria(); }, 86400000); 
setTimeout(() => { varreduraIgreenDiaria(); }, 15000);

// Rotas básicas para manter o servidor vivo e receber WhatsApp
app.get('/', (req, res) => res.send('Robô iGreen Ativo e Colhendo Dados Profundos!'));
app.post('/webhook/igreen', (req, res) => { res.status(200).send("OK"); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Motor ligado na porta ${PORT}`));    
