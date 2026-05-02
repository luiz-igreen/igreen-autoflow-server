<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Monitor Oficial RPA - iGreen AutoFlow</title>
    
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    
    <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js"></script>
    
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800;900&display=swap');
        @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600&display=swap');
        
        body { 
            font-family: 'Montserrat', sans-serif; 
            background-color: #0f172a; /* Fundo principal escuro */
            color: #f8fafc; 
            margin: 0; 
            height: 100vh; 
            overflow: hidden; 
            display: flex; 
            flex-direction: column; 
        }
        
        /* Emulador Mobile (Estilo Dark/White misto do print) */
        .mobile-container { 
            width: 380px; 
            height: 780px; 
            background-color: #1e293b; 
            border-radius: 40px; 
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); 
            border: 10px solid #020617; 
            display: flex; 
            flex-direction: column; 
            position: relative; 
            overflow: hidden; 
        }
        
        .step-content { display: none; height: 100%; flex-direction: column; background: #ffffff; border-radius: 30px 30px 0 0; }
        .step-content.active { display: flex; animation: fadeIn 0.4s ease-out forwards; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        .igreen-input { 
            width: 100%; background-color: #ffffff; border: 1px solid #e2e8f0; 
            padding: 14px 16px; border-radius: 12px; font-size: 13px; color: #1e293b; 
            font-weight: 700; outline: none; transition: all 0.2s; 
        }
        .igreen-input.robot-typing { 
            border-color: #10b981; background-color: #f0fdf4; 
            box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2); transform: scale(1.01); 
        }
        
        .upload-box { 
            border: 2px dashed #cbd5e1; background: #ffffff; border-radius: 16px; 
            padding: 16px; text-align: center; transition: all 0.3s; 
        }
        .upload-box.injected { border-color: #10b981; background: #f0fdf4; transform: scale(1.05); }

        .console-font { font-family: 'Fira Code', monospace; }
        .log-entry { margin-bottom: 8px; animation: slideDown 0.3s ease-out; padding-left: 10px; border-left: 2px solid transparent; }
        .log-entry.active { border-left-color: #10b981; background: rgba(16, 185, 129, 0.1); border-radius: 0 4px 4px 0;}
        @keyframes slideDown { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }

        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
    </style>
</head>
<body class="p-6">

    <!-- HEADER TOPO -->
    <header class="flex justify-between items-center mb-6 bg-[#1e293b] p-5 rounded-2xl border border-slate-700 shrink-0 shadow-xl">
        <div class="flex items-center gap-5">
            <div class="bg-gradient-to-br from-emerald-400 to-emerald-600 w-14 h-14 rounded-2xl shadow-[0_0_20px_rgba(16,185,129,0.3)] flex items-center justify-center text-white">
                <i class="fas fa-robot text-3xl"></i>
            </div>
            <div>
                <h1 class="text-2xl font-black text-white tracking-tight">Monitor RPA Oficial <span class="text-emerald-400">V46</span></h1>
                <p class="text-[10px] font-bold text-blue-400 uppercase tracking-widest flex items-center mt-1">
                    <i class="fas fa-satellite-dish mr-2 animate-pulse"></i>
                    Sincronizado com o servidor nas nuvens
                </p>
            </div>
        </div>
        <button onclick="location.reload()" class="bg-[#334155] hover:bg-[#475569] text-white px-6 py-3 rounded-xl text-xs font-bold transition-colors border border-slate-600 shadow-md">
            <i class="fas fa-sync-alt mr-2"></i> Atualizar Conexão
        </button>
    </header>

    <div class="flex flex-1 gap-8 min-h-0">
        
        <!-- COLUNA ESQUERDA: O TELEMÓVEL DO ROBÔ -->
        <div class="flex flex-col items-center shrink-0 relative">
            <div class="absolute -top-4 bg-emerald-500/10 text-emerald-400 px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border border-emerald-500/20 flex items-center gap-2 shadow-[0_0_10px_rgba(16,185,129,0.1)] z-10">
                <i class="fas fa-eye"></i> Visão do Robô
            </div>
            
            <div class="mobile-container mt-4">
                <header class="bg-[#1e293b] text-white p-6 flex items-center gap-4 shrink-0">
                    <div class="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center font-black italic text-base shadow-inner">iG</div>
                    <div>
                        <h2 class="text-sm font-black uppercase tracking-widest">Portal iGreen</h2>
                        <p class="text-[10px] text-emerald-400 font-bold mt-0.5">Injeção Autônoma</p>
                    </div>
                </header>

                <div class="flex-1 overflow-y-auto relative p-6 pb-24" id="appScrollArea">
                    <!-- Camada de bloqueio visual -->
                    <div class="absolute inset-0 z-50 cursor-not-allowed"></div>

                    <!-- PASSO 1: DADOS PESSOAIS -->
                    <div id="step1" class="step-content active pt-6">
                        <h3 class="text-lg font-black text-slate-800 mb-6 flex items-center gap-3">
                            <span class="bg-slate-200 w-8 h-8 flex items-center justify-center rounded-full text-sm text-slate-600">1</span> 
                            Dados Pessoais
                        </h3>
                        <div class="space-y-4 px-2">
                            <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">Nome Completo</label><input type="text" id="app_nome" class="igreen-input mt-1" placeholder="..."></div>
                            <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">CPF / CNPJ</label><input type="text" id="app_cpf" class="igreen-input font-mono text-emerald-600 mt-1" placeholder="..."></div>
                            <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">Data de Nascimento</label><input type="text" id="app_nasc" class="igreen-input font-mono mt-1" placeholder="..."></div>
                            <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">E-mail</label><input type="text" id="app_email" class="igreen-input text-blue-600 mt-1" placeholder="..."></div>
                            <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">WhatsApp</label><input type="text" id="app_tel" class="igreen-input font-mono mt-1" placeholder="..."></div>
                        </div>
                    </div>

                    <!-- PASSO 2: ENDEREÇO -->
                    <div id="step2" class="step-content pt-6">
                        <h3 class="text-lg font-black text-slate-800 mb-6 flex items-center gap-3">
                            <span class="bg-slate-200 w-8 h-8 flex items-center justify-center rounded-full text-sm text-slate-600">2</span> 
                            Endereço
                        </h3>
                        <div class="space-y-4 px-2">
                            <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">CEP</label><input type="text" id="app_cep" class="igreen-input font-mono text-emerald-600 mt-1" placeholder="..."></div>
                            <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">Rua / Logradouro</label><input type="text" id="app_rua" class="igreen-input mt-1" placeholder="..."></div>
                            <div class="grid grid-cols-3 gap-3">
                                <div class="col-span-1"><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest text-red-500">Número</label><input type="text" id="app_num" class="igreen-input font-black mt-1" placeholder="..."></div>
                                <div class="col-span-2"><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">Bairro</label><input type="text" id="app_bairro" class="igreen-input mt-1" placeholder="..."></div>
                            </div>
                            <div class="grid grid-cols-4 gap-3">
                                <div class="col-span-3"><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">Cidade</label><input type="text" id="app_cidade" class="igreen-input mt-1" placeholder="..."></div>
                                <div class="col-span-1"><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">UF</label><input type="text" id="app_uf" class="igreen-input font-black text-center mt-1" placeholder="..."></div>
                            </div>
                        </div>
                    </div>

                    <!-- PASSO 3: TÉCNICOS E UPLOADS -->
                    <div id="step3" class="step-content pt-6">
                        <h3 class="text-lg font-black text-slate-800 mb-6 flex items-center gap-3">
                            <span class="bg-slate-200 w-8 h-8 flex items-center justify-center rounded-full text-sm text-slate-600">3</span> 
                            Conta e Anexos
                        </h3>
                        <div class="space-y-4 px-2">
                            <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">Distribuidora</label><input type="text" id="app_dist" class="igreen-input font-bold mt-1" placeholder="..."></div>
                            <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">Nº Instalação (UC)</label><input type="text" id="app_uc" class="igreen-input font-mono font-black text-indigo-600 mt-1" placeholder="..."></div>
                            <div class="grid grid-cols-2 gap-3">
                                <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">Mês Ref.</label><input type="text" id="app_mes" class="igreen-input font-mono text-center mt-1" placeholder="..."></div>
                                <div><label class="text-[10px] text-slate-500 font-bold uppercase ml-1 tracking-widest">Média (kWh)</label><input type="text" id="app_media" class="igreen-input font-mono font-bold text-emerald-600 text-center mt-1" placeholder="..."></div>
                            </div>
                            
                            <div class="pt-6 border-t border-slate-100 mt-6">
                                <p class="text-[10px] font-bold text-slate-500 mb-4 uppercase tracking-widest">Injeção de Arquivos (Upload)</p>
                                <div class="grid grid-cols-3 gap-3">
                                    <div id="box_fat" class="upload-box"><i id="icon_fat" class="fas fa-file-pdf text-2xl text-slate-300 mb-2"></i><p id="lbl_fat" class="text-[9px] font-bold text-slate-400 uppercase">Fatura</p></div>
                                    <div id="box_fre" class="upload-box"><i id="icon_fre" class="fas fa-id-card text-2xl text-slate-300 mb-2"></i><p id="lbl_fre" class="text-[9px] font-bold text-slate-400 uppercase">Frente RG</p></div>
                                    <div id="box_ver" class="upload-box"><i id="icon_ver" class="fas fa-id-card text-2xl text-slate-300 mb-2"></i><p id="lbl_ver" class="text-[9px] font-bold text-slate-400 uppercase">Verso RG</p></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- PASSO 4: SUCESSO -->
                    <div id="step4" class="step-content bg-emerald-50 relative">
                        <div class="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
                            <div class="w-28 h-28 bg-emerald-500 rounded-full flex items-center justify-center shadow-[0_0_50px_rgba(16,185,129,0.4)] mb-8">
                                <i class="fas fa-check text-6xl text-white"></i>
                            </div>
                            <h2 class="text-3xl font-black text-slate-800 mb-3 tracking-tight">Simulação Concluída!</h2>
                            <p class="text-sm font-medium text-slate-600 leading-relaxed">A Máquina de Guerra injetou todos os campos da nova jornada da iGreen.</p>
                        </div>
                    </div>

                </div>

                <!-- Botão Fixo de Avanço do Robô -->
                <div id="formFooter" class="absolute bottom-0 left-0 w-full p-6 bg-white/90 backdrop-blur-sm z-20 shrink-0">
                    <button id="btnApp" class="w-full bg-slate-200 text-slate-400 font-black py-4 rounded-2xl text-sm uppercase tracking-widest transition-all">
                        Aguardando IA...
                    </button>
                </div>
            </div>
        </div>

        <!-- COLUNA DIREITA: PAINEL DE DADOS E TERMINAL -->
        <div class="flex-1 flex flex-col gap-6 min-w-0">
            
            <!-- A GRELHA DE DADOS REAL (DARK MODE NEON) -->
            <div class="bg-[#1e293b] rounded-[2rem] border border-slate-700 shadow-2xl overflow-hidden flex-1 flex flex-col">
                <div class="bg-[#0f172a]/60 p-6 border-b border-slate-700 flex justify-between items-center shrink-0">
                    <div class="flex items-center gap-4">
                        <div class="bg-blue-500/20 p-2.5 rounded-xl border border-blue-500/30">
                            <i class="fas fa-database text-blue-400 text-xl"></i>
                        </div>
                        <div>
                            <h2 class="text-white font-black text-sm tracking-widest uppercase">Base de Dados <span class="text-emerald-500">iGreen (21 Campos)</span></h2>
                            <p class="text-slate-400 text-[10px] mt-1 font-bold">Espelho exato do que a Inteligência Artificial extraiu.</p>
                        </div>
                    </div>
                    <span id="badgeStatus" class="bg-slate-700 text-slate-400 border border-slate-600 px-4 py-2 rounded-xl text-[10px] font-black tracking-widest uppercase">
                        Conectando...
                    </span>
                </div>
                
                <div class="p-6 overflow-y-auto bg-[#1e293b] relative flex-1">
                    <div id="loadingDb" class="absolute inset-0 bg-[#1e293b]/95 z-10 flex flex-col items-center justify-center transition-opacity duration-500">
                        <i class="fas fa-spinner fa-spin text-5xl text-emerald-500 mb-6"></i>
                        <p class="text-white font-black tracking-widest text-sm uppercase">A escutar o servidor (WhatsApp)...</p>
                    </div>

                    <!-- Campos Reais Mapeados da IA -->
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">TIPO_PERFIL</p><p class="text-xs font-bold text-white" id="db_tipo">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80 lg:col-span-2"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">NOME_CLIENTE</p><p class="text-sm font-black text-white truncate" id="db_nome">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">CPF / CNPJ</p><p class="text-sm font-mono font-bold text-emerald-400" id="db_cpf">-</p></div>
                        
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">DATA_NASCIMENTO</p><p class="text-xs font-mono font-bold text-white" id="db_nasc">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80 lg:col-span-2"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">EMAIL</p><p class="text-xs font-bold text-blue-400 truncate" id="db_email">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">WHATSAPP</p><p class="text-xs font-mono font-bold text-white" id="db_tel">-</p></div>

                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">CEP</p><p class="text-xs font-mono font-bold text-emerald-400" id="db_cep">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80 lg:col-span-2"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">ENDERECO</p><p class="text-xs font-bold text-white truncate" id="db_rua">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">NUMERO</p><p class="text-sm font-black text-red-400" id="db_numero">-</p></div>
                        
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">BAIRRO</p><p class="text-xs font-bold text-white truncate" id="db_bairro">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80 lg:col-span-2"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">CIDADE</p><p class="text-xs font-bold text-white truncate" id="db_cidade">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">ESTADO</p><p class="text-sm font-black text-white" id="db_uf">-</p></div>

                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80 lg:col-span-2"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">DISTRIBUIDORA</p><p class="text-xs font-bold text-white truncate" id="db_dist">-</p></div>
                        <div class="bg-emerald-900/20 p-4 rounded-xl border border-emerald-500/30"><p class="text-[9px] text-emerald-500 font-black uppercase mb-1.5 tracking-widest">UC_INSTALACAO</p><p class="text-sm font-mono font-black text-emerald-400" id="db_uc">-</p></div>
                        <div class="bg-emerald-900/20 p-4 rounded-xl border border-emerald-500/30"><p class="text-[9px] text-emerald-500 font-black uppercase mb-1.5 tracking-widest">MEDIA_CONSUMO</p><p class="text-sm font-mono font-black text-emerald-400" id="db_media">-</p></div>

                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">CONTA_MES</p><p class="text-xs font-bold text-blue-300" id="db_mes">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">VENCIMENTO</p><p class="text-xs font-bold text-red-300" id="db_venc">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80 lg:col-span-2"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest">VALOR_FATURA</p><p class="text-sm font-mono font-bold text-slate-300" id="db_valor">-</p></div>

                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80 lg:col-span-4"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest"><i class="fas fa-link mr-1"></i> LINK_FATURA</p><p class="text-[10px] text-blue-400 break-all" id="db_link_fat">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80 lg:col-span-2"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest"><i class="fas fa-link mr-1"></i> LINK_FRENTE</p><p class="text-[10px] text-orange-400 break-all" id="db_link_fre">-</p></div>
                        <div class="bg-[#0f172a]/50 p-4 rounded-xl border border-slate-700/80 lg:col-span-2"><p class="text-[9px] text-slate-400 font-bold uppercase mb-1.5 tracking-widest"><i class="fas fa-link mr-1"></i> LINK_VERSO</p><p class="text-[10px] text-orange-400 break-all" id="db_link_ver">-</p></div>
                    </div>
                </div>

                <div class="p-5 border-t border-slate-700 bg-[#1e293b] shrink-0">
                    <button id="btnAutoStart" onclick="iniciarAutomacao()" disabled class="w-full bg-[#0f172a] text-slate-500 font-black py-5 rounded-2xl flex items-center justify-center gap-3 uppercase tracking-[0.2em] text-sm transition-all duration-300 border border-slate-800">
                        <i class="fas fa-lock"></i> Aguardando Cliente
                    </button>
                </div>
            </div>

            <!-- TERMINAL DO ROBÔ -->
            <div class="bg-[#0a0f1c] rounded-[2rem] border border-slate-800 shadow-2xl overflow-hidden flex flex-col h-72 shrink-0">
                <div class="bg-[#1e293b] p-4 border-b border-slate-800 flex justify-between items-center shrink-0">
                    <span class="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><i class="fas fa-terminal"></i> Terminal de Execução RPA</span>
                    <i class="fas fa-circle text-slate-600 text-[8px]" id="statusLed"></i>
                </div>
                <div class="p-6 overflow-y-auto console-font text-xs flex-1 custom-scroll" id="terminal">
                    <div class="text-slate-600 mb-4">// Servidor Node.js - Motor Puppeteer Preparado</div>
                </div>
            </div>

        </div>
    </div>

    <script>
        const firebaseConfig = {
          apiKey: "AIzaSyB4bGHVNgOMFJmyKhHJVLScsmr1tWy2uhQ",
          authDomain: "igreen-autoflow.firebaseapp.com",
          projectId: "igreen-autoflow",
          storageBucket: "igreen-autoflow.firebasestorage.app",
          messagingSenderId: "1074994206249",
          appId: "1:1074994206249:web:41dec2e150e137db11ae38"
        };

        firebase.initializeApp(firebaseConfig);
        const auth = firebase.auth();
        const db = firebase.firestore();
        const appId = 'igreen-autoflow-v4';

        let leadDB = {};
        let ultimoLeadInjetado = ""; 

        auth.signInAnonymously().then(() => {
            logRPA("Conectado ao Firebase. Aguardando o cliente no WhatsApp...", "system");
            const leadsRef = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads');
            
            leadsRef.onSnapshot(snapshot => {
                if (snapshot.empty) return;

                let docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                docs.sort((a, b) => {
                    const timeA = a.DATA_PROCESSAMENTO?.seconds || 0;
                    const timeB = b.DATA_PROCESSAMENTO?.seconds || 0;
                    return timeB - timeA;
                });

                const latestLead = docs[0];
                const leadId = latestLead.id;

                // Mapeamento EXATO dos campos que a IA extrai (Com blindagem de fallback)
                leadDB = {
                    TIPO_PERFIL: latestLead.TIPO_PERFIL || "",
                    NOME: latestLead.NOME_CLIENTE || latestLead.nome_cliente || "",
                    CPF: latestLead.CPF || latestLead.MASCARA_CPF || latestLead.CNPJ || latestLead.MASCARA_CNPJ || "",
                    DATA_NASC: latestLead.DATA_NASCIMENTO || "Não informado",
                    EMAIL: latestLead.EMAIL || "",
                    TEL: latestLead.TELEFONE || latestLead.telefone || "",
                    CEP: latestLead.CEP || "",
                    RUA: latestLead.ENDERECO || "",
                    NUMERO: latestLead.ENDERECO_NUMERO || "",
                    BAIRRO: latestLead.BAIRRO || "",
                    CIDADE: latestLead.CIDADE || "",
                    UF: latestLead.ESTADO || "",
                    DIST: latestLead.DISTRIBUIDORA || "",
                    UC: latestLead.UC || "",
                    CONTA_MES: latestLead.CONTA_MES || "Não identificado",
                    VENCIMENTO: latestLead.VENCIMENTO || "Não identificado",
                    VALOR: latestLead.VALOR_FATURA || "0.00",
                    MEDIA: latestLead.MEDIA_CONSUMO || "0",
                    LINK_FAT: latestLead.LINK_FATURA || latestLead.url_fatura || "",
                    LINK_FRE: latestLead.LINK_DOC_FRENTE || "",
                    LINK_VER: latestLead.LINK_DOC_VERSO || ""
                };
                
                try { carregarPainelDB(); } catch (err) {}
                
                if (latestLead.STATUS_CADASTRO === 'CONCLUIDO') {
                    document.getElementById('loadingDb').classList.add('opacity-0', 'pointer-events-none');
                    document.getElementById('badgeStatus').className = "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-4 py-2 rounded-xl text-[10px] font-black tracking-widest uppercase shadow-[0_0_15px_rgba(16,185,129,0.3)]";
                    document.getElementById('badgeStatus').innerHTML = "<i class='fas fa-check-circle mr-1'></i> PRONTO PARA INJEÇÃO";
                    
                    const btnAuto = document.getElementById('btnAutoStart');
                    btnAuto.disabled = false;
                    btnAuto.className = "w-full bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-slate-950 font-black py-5 rounded-2xl shadow-[0_0_40px_rgba(16,185,129,0.4)] flex items-center justify-center gap-3 uppercase tracking-[0.2em] text-sm cursor-pointer hover:scale-[1.02] transition-transform";
                    btnAuto.innerHTML = `<i class="fas fa-bolt text-lg"></i> DISPARAR ROBÔ NA TELA`;
                    
                    if (ultimoLeadInjetado !== leadId) {
                        ultimoLeadInjetado = leadId;
                        logRPA("O WhatsApp terminou o atendimento. Status: CONCLUIDO.", "success");
                        logRPA("Aguardando clique no botão verde para exibir a simulação...", "info");
                    }
                } else {
                    document.getElementById('loadingDb').classList.remove('opacity-0', 'pointer-events-none');
                    document.getElementById('loadingDb').innerHTML = `
                        <i class="fab fa-whatsapp text-6xl text-emerald-500 mb-6 animate-pulse drop-shadow-[0_0_20px_rgba(16,185,129,0.5)]"></i>
                        <p class="text-white font-black text-sm tracking-[0.2em] uppercase">A conversar com o cliente...</p>
                        <p class="text-emerald-400 text-[10px] mt-4 font-mono bg-emerald-900/40 px-5 py-2.5 rounded-xl border border-emerald-500/40 uppercase tracking-widest">${latestLead.STATUS_CADASTRO || 'INICIANDO'}</p>
                    `;
                }
            });
        }).catch(err => { logRPA(`Erro DB: ${err.message}`, "error"); });

        function carregarPainelDB() {
            const safeSet = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val || "-"; };
            const safeLink = (id, val) => { 
                const el = document.getElementById(id); 
                if (el) el.innerHTML = val ? `<a href="${val}" target="_blank" class="hover:text-emerald-300 underline"><i class="fas fa-external-link-alt text-[8px] mr-1"></i>Acessar Arquivo</a>` : "<span class='text-slate-600'>Não enviado</span>"; 
            };

            safeSet('db_tipo', leadDB.TIPO_PERFIL);
            safeSet('db_nome', leadDB.NOME);
            safeSet('db_cpf', leadDB.CPF);
            safeSet('db_nasc', leadDB.DATA_NASC);
            safeSet('db_email', leadDB.EMAIL);
            safeSet('db_tel', leadDB.TEL);
            safeSet('db_cep', leadDB.CEP);
            safeSet('db_rua', leadDB.RUA);
            safeSet('db_numero', leadDB.NUMERO);
            safeSet('db_bairro', leadDB.BAIRRO);
            safeSet('db_cidade', leadDB.CIDADE);
            safeSet('db_uf', leadDB.UF);
            safeSet('db_dist', leadDB.DIST);
            safeSet('db_uc', leadDB.UC);
            safeSet('db_mes', leadDB.CONTA_MES);
            safeSet('db_venc', leadDB.VENCIMENTO);
            safeSet('db_valor', leadDB.VALOR !== "" ? `R$ ${leadDB.VALOR}` : "-");
            safeSet('db_media', leadDB.MEDIA !== "" ? `${leadDB.MEDIA} kWh` : "-");

            safeLink('db_link_fat', leadDB.LINK_FAT);
            safeLink('db_link_fre', leadDB.LINK_FRE);
            safeLink('db_link_ver', leadDB.LINK_VER);
        }

        function logRPA(message, type = "info") {
            const terminal = document.getElementById('terminal');
            const div = document.createElement('div');
            let colorClass = "text-slate-500";
            if(type === "action") colorClass = "text-blue-400 font-bold";
            if(type === "success") colorClass = "text-emerald-400 font-bold";
            if(type === "error") colorClass = "text-red-400 font-bold";
            
            div.className = `log-entry active ${colorClass}`;
            div.innerHTML = `<span class="opacity-50 mr-2">[${new Date().toLocaleTimeString().split(' ')[0]}]</span> > ${message}`;
            terminal.appendChild(div);
            terminal.scrollTop = terminal.scrollHeight;
            setTimeout(() => div.classList.remove('active'), 300);
        }

        // DIGITAÇÃO SUAVE E LENTA PARA O SHOW
        async function robotType(elementId, text) {
            const el = document.getElementById(elementId);
            if (!el || !text || text === "-" || text === "Não informado") return;
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 100)); 
            el.classList.add('robot-typing');
            el.value = "";
            logRPA(`Preenchendo: ${elementId}...`, "action");
            
            for (let char of String(text)) {
                el.value += char;
                await new Promise(r => setTimeout(r, 40)); 
            }
            await new Promise(r => setTimeout(r, 200));
            el.classList.remove('robot-typing');
        }

        function switchScreen(screenId, btnText) {
            document.querySelectorAll('.step-content').forEach(el => el.classList.remove('active'));
            const target = document.getElementById(screenId);
            if (target) target.classList.add('active');
            document.getElementById('appScrollArea').scrollTop = 0;
            const btn = document.getElementById('btnApp');
            if (btn && btnText) {
                btn.innerText = btnText;
                btn.className = `w-full bg-[#1e293b] text-slate-300 font-black py-4 rounded-2xl shadow-lg transition-all text-xs uppercase tracking-[0.2em] relative overflow-hidden`;
            }
        }

        async function animateUpload(boxId, iconId, lblId, link, msg) {
            if(!link || link === "-") return;
            const box = document.getElementById(boxId);
            if (!box) return;
            box.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 200));
            box.classList.add('injected');
            document.getElementById(iconId).className = 'fas fa-check-circle text-4xl text-emerald-500 mb-3';
            document.getElementById(lblId).innerHTML = msg;
            document.getElementById(lblId).classList.replace('text-slate-400', 'text-emerald-600');
            logRPA(`Upload invisível de ficheiro injetado com sucesso.`, "success");
            await new Promise(r => setTimeout(r, 600));
            box.classList.remove('injected');
        }

        window.iniciarAutomacao = async function() {
            const btnAuto = document.getElementById('btnAutoStart');
            btnAuto.disabled = true;
            btnAuto.className = "w-full bg-[#1e293b] text-emerald-500 font-black py-5 rounded-2xl flex items-center justify-center gap-3 uppercase tracking-[0.2em] text-sm transition-all duration-300 border border-emerald-500/30";
            btnAuto.innerHTML = `<i class="fas fa-cogs animate-spin text-lg"></i> Robô a trabalhar...`;

            document.getElementById('statusLed').classList.replace('text-slate-600', 'text-emerald-500');
            document.getElementById('statusLed').classList.add('animate-pulse');
            logRPA("⚡ INJEÇÃO INICIADA! A MÁQUINA DE GUERRA ASSUMIU O COMANDO DA TELA.", "success");

            // ETAPA 1
            switchScreen('step1', 'Avançar para Endereço >');
            await new Promise(r => setTimeout(r, 600));
            await robotType('app_nome', leadDB.NOME);
            await robotType('app_cpf', leadDB.CPF);
            await robotType('app_nasc', leadDB.DATA_NASC);
            await robotType('app_email', leadDB.EMAIL);
            await robotType('app_tel', leadDB.TEL);
            logRPA("Clicou em Avançar.", "info");

            // ETAPA 2
            switchScreen('step2', 'Avançar para Técnicos >');
            await new Promise(r => setTimeout(r, 600));
            await robotType('app_cep', leadDB.CEP);
            await robotType('app_rua', leadDB.RUA);
            await robotType('app_num', leadDB.NUMERO);
            await robotType('app_bairro', leadDB.BAIRRO); 
            await robotType('app_cidade', leadDB.CIDADE); 
            await robotType('app_uf', leadDB.UF);
            logRPA("Clicou em Avançar.", "info");

            // ETAPA 3
            switchScreen('step3', 'Injetar e Finalizar Tudo!');
            await new Promise(r => setTimeout(r, 600));
            await robotType('app_dist', leadDB.DIST);
            await robotType('app_uc', leadDB.UC);
            await robotType('app_mes', leadDB.CONTA_MES);
            await robotType('app_media', leadDB.MEDIA);
            
            logRPA("Iniciando injeção de Imagens e PDFs via script...", "action");
            await animateUpload('box_fat', 'icon_fat', 'lbl_fat', leadDB.LINK_FAT, 'Fatura Anexada');
            await animateUpload('box_fre', 'icon_fre', 'lbl_fre', leadDB.LINK_FRE, 'Frente Anexada');
            await animateUpload('box_ver', 'icon_ver', 'lbl_ver', leadDB.LINK_VER, 'Verso Anexado');

            logRPA("Clicou em Gerar Contrato.", "info");
            await new Promise(r => setTimeout(r, 800));

            // ETAPA FINAL
            document.getElementById('formFooter').classList.add('hidden');
            switchScreen('step4');
            
            logRPA("✅ SUCESSO ABSOLUTO! TODOS OS DADOS FORAM INJETADOS COM PERFEIÇÃO.", "success");
            
            document.getElementById('statusLed').classList.remove('animate-pulse');

            btnAuto.className = "w-full bg-emerald-900/30 border border-emerald-500/50 text-emerald-400 font-black py-5 rounded-2xl flex items-center justify-center gap-3 uppercase tracking-[0.2em] text-sm";
            btnAuto.innerHTML = `<i class="fas fa-check-double text-lg"></i> Injeção Finalizada`;
        };
    </script>
</body>
</html>
