<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>iGreen AutoFlow - Dashboard Multi-Nível</title>
    
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    
    <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js"></script>
    
    <style>
        body { background-color: #f1f5f9; font-family: 'Segoe UI', Roboto, sans-serif; }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-track { background: #f1f1f1; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
    </style>
</head>
<body>
    <div id="root"></div>

    <script type="text/babel">
        const { useState, useEffect, useMemo } = React;

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

        function App() {
            const [leads, setLeads] = useState([]);
            const [loading, setLoading] = useState(true);
            const [searchTerm, setSearchTerm] = useState("");
            const [leadToDelete, setLeadToDelete] = useState(null);
            const [activeTab, setActiveTab] = useState('TODOS'); // 🔥 NOVA ABA ATIVA

            useEffect(() => {
                auth.signInAnonymously().catch(console.error);
                const unsubscribeAuth = auth.onAuthStateChanged(user => {
                    if (user) {
                        const leadsRef = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads');
                        const unsubscribeDb = leadsRef.onSnapshot(snapshot => {
                            const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                            data.sort((a,b) => (b.DATA_PROCESSAMENTO?.seconds || 0) - (a.DATA_PROCESSAMENTO?.seconds || 0));
                            setLeads(data);
                            setLoading(false);
                        }, err => {
                            console.error("Erro DB:", err);
                            setLoading(false);
                        });
                        return () => unsubscribeDb();
                    }
                });
                return () => unsubscribeAuth();
            }, []);

            const handleDeleteConfirm = async () => {
                if (!leadToDelete) return;
                try {
                    await db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads').doc(leadToDelete.id).delete();
                    setLeadToDelete(null); 
                } catch (error) { alert("Houve um erro ao tentar excluir o cadastro."); }
            };

            const formatDate = (timestamp) => {
                if (!timestamp) return "-";
                const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp.seconds * 1000 || timestamp);
                if (isNaN(date.getTime())) return "-";
                return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            };

            // 🔥 SEPARAÇÃO DE DADOS MULTI-NÍVEL
            const leadsReais = leads.filter(l => !String(l.id || l.TELEFONE || "").toLowerCase().includes("group"));
            
            // Pega todos os códigos de licenciados únicos para gerar os botões
            const uniqueDonos = useMemo(() => {
                const donos = leadsReais.map(l => l.DONO_REDE).filter(Boolean);
                return [...new Set(donos)].sort();
            }, [leadsReais]);

            // Filtra os clientes da aba atual
            const filtradosTab = leadsReais.filter(l => activeTab === 'TODOS' || l.DONO_REDE === activeTab);
            
            // Filtra pela barra de pesquisa
            const filtradosBusca = filtradosTab.filter(l => {
                return (l.NOME_CLIENTE || "").toLowerCase().includes(searchTerm.toLowerCase()) || 
                (l.TELEFONE || "").includes(searchTerm) || (l.UC || "").includes(searchTerm) || (l.CODIGO_CLIENTE || "").includes(searchTerm)
            });

            // Recalcula KPIs baseados apenas na aba clicada
            const totalGeral = filtradosTab.length;
            const totalCompletos = filtradosTab.filter(l => l.LINK_FATURA && l.LINK_DOC_FRENTE && l.STATUS_CADASTRO !== 'INATIVO').length;
            const totalPendentes = totalGeral - totalCompletos;

            return (
                <div className="min-h-screen p-4 md:p-8 relative">
                    {leadToDelete && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                            <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 border border-slate-200">
                                <div className="flex items-center space-x-4 text-red-600 mb-6 border-b border-slate-100 pb-4">
                                    <div className="bg-red-100 p-3 rounded-full"><i className="fas fa-exclamation-triangle text-2xl"></i></div>
                                    <h3 className="text-xl font-black tracking-tight">Confirmar Exclusão</h3>
                                </div>
                                <p className="text-sm text-slate-600 mb-2">Tem a certeza que deseja apagar o cadastro e todos os dados associados a:</p>
                                <div className="bg-slate-50 p-4 rounded-xl mb-8 border border-slate-100">
                                    <p className="font-black text-slate-800">{leadToDelete.NOME_CLIENTE || "Cliente Sem Nome"}</p>
                                    <p className="font-mono text-xs text-slate-500 mt-1">Telefone: {leadToDelete.TELEFONE}</p>
                                </div>
                                <div className="flex justify-end space-x-3">
                                    <button onClick={() => setLeadToDelete(null)} className="px-6 py-3 rounded-xl text-sm font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors">Cancelar</button>
                                    <button onClick={handleDeleteConfirm} className="px-6 py-3 rounded-xl text-sm font-bold text-white bg-red-600 hover:bg-red-700 shadow-lg shadow-red-200 transition-all"><i className="fas fa-trash-alt mr-2"></i> Apagar</button>
                                </div>
                            </div>
                        </div>
                    )}

                    <header className="max-w-[1800px] mx-auto flex flex-col md:flex-row justify-between items-center mb-6 bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                        <div className="flex items-center space-x-4 mb-4 md:mb-0">
                            <div className="bg-emerald-600 p-3 rounded-xl shadow-lg shadow-emerald-200 text-white"><i className="fas fa-sitemap text-xl"></i></div>
                            <div>
                                <h1 className="text-2xl font-black text-slate-800 tracking-tight">Cloud Database <span className="text-emerald-600">iGreen AutoFlow</span></h1>
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center mt-1">
                                    <i className="fas fa-circle text-emerald-500 mr-2 animate-pulse" style={{fontSize: '8px'}}></i>
                                    GESTÃO MULTI-NÍVEL (REDE)
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center space-x-4">
                            <div className="relative">
                                <i className="fas fa-search absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 text-sm"></i>
                                <input type="text" placeholder="Procurar cliente, Código ou UC..." className="pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm w-72 focus:outline-none focus:border-emerald-500 transition-colors" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
                            </div>
                            <button className="bg-slate-800 text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-slate-700 transition"><i className="fas fa-download mr-2"></i> Exportar CSV</button>
                        </div>
                    </header>

                    {/* 🔥 BOTÕES DE ABAS (TABS) */}
                    <div className="max-w-[1800px] mx-auto flex space-x-2 mb-4 overflow-x-auto pb-2">
                        <button onClick={() => setActiveTab('TODOS')} className={`px-5 py-2 rounded-xl font-bold text-xs shadow-sm transition-all whitespace-nowrap ${activeTab === 'TODOS' ? 'bg-slate-800 text-white shadow-slate-300' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}>
                            <i className="fas fa-globe mr-2"></i> VISÃO GERAL (Todos)
                        </button>
                        <button onClick={() => setActiveTab('76049')} className={`px-5 py-2 rounded-xl font-bold text-xs shadow-sm transition-all whitespace-nowrap ${activeTab === '76049' ? 'bg-emerald-600 text-white shadow-emerald-200' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}>
                            <i className="fas fa-crown mr-2 text-amber-300"></i> MEUS DIRETOS (76.049)
                        </button>
                        {uniqueDonos.filter(d => d !== '76049' && d !== '76.049' && d).map(dono => (
                            <button key={dono} onClick={() => setActiveTab(dono)} className={`px-5 py-2 rounded-xl font-bold text-xs shadow-sm transition-all whitespace-nowrap ${activeTab === dono ? 'bg-blue-600 text-white shadow-blue-200' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}>
                                <i className="fas fa-users mr-2"></i> EQUIPE ({dono})
                            </button>
                        ))}
                    </div>

                    <div className="max-w-[1800px] mx-auto grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm flex items-center justify-between">
                            <div>
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Total de Cadastros</p>
                                <h2 className="text-4xl font-black text-slate-800">{loading ? "-" : totalGeral}</h2>
                            </div>
                            <div className="bg-slate-50 text-slate-400 p-4 rounded-xl text-2xl"><i className="fas fa-chart-line"></i></div>
                        </div>

                        <div className="bg-white rounded-2xl p-6 border border-emerald-200 shadow-sm flex items-center justify-between">
                            <div>
                                <p className="text-xs font-bold text-emerald-600 uppercase tracking-wider mb-1">100% Completos</p>
                                <h2 className="text-4xl font-black text-emerald-700">{loading ? "-" : totalCompletos}</h2>
                            </div>
                            <div className="bg-emerald-50 text-emerald-500 p-4 rounded-xl text-2xl"><i className="fas fa-shield-check"></i></div>
                        </div>

                        <div className="bg-white rounded-2xl p-6 border border-amber-200 shadow-sm flex items-center justify-between">
                            <div>
                                <p className="text-xs font-bold text-amber-600 uppercase tracking-wider mb-1">Incompletos / Pendentes</p>
                                <h2 className="text-4xl font-black text-amber-700">{loading ? "-" : totalPendentes}</h2>
                            </div>
                            <div className="bg-amber-50 text-amber-500 p-4 rounded-xl text-2xl"><i className="fas fa-clock"></i></div>
                        </div>
                    </div>

                    <main className="max-w-[1800px] mx-auto bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden min-h-[500px]">
                        <div className="overflow-x-auto pb-4">
                            <table className="w-full text-left whitespace-nowrap">
                                <thead>
                                    <tr className="bg-slate-100 border-b border-slate-200 text-[10px] font-black uppercase tracking-wider text-slate-600">
                                        <th className="p-3 sticky left-0 bg-slate-200 z-10 shadow-[1px_0_0_#cbd5e1]">AÇÕES</th>
                                        <th className="p-3">DATA</th>
                                        <th className="p-3">STATUS</th>
                                        <th className="p-3 text-emerald-700 bg-emerald-50">CÓDIGO</th>
                                        <th className="p-3">NOME_CLIENTE</th>
                                        <th className="p-3">DATA_NASCIMENTO</th>
                                        <th className="p-3">CPF</th>
                                        <th className="p-3">TELEFONE</th>
                                        <th className="p-3 text-indigo-700 bg-indigo-50 border-l border-indigo-100">DONO_REDE</th>
                                        <th className="p-3 text-center bg-blue-50 text-blue-800 border-l border-blue-100">CONTA_MES</th>
                                        <th className="p-3 text-center bg-red-50 text-red-800 border-r border-red-100">VENCIMENTO</th>
                                        <th className="p-3">EMAIL</th>
                                        <th className="p-3">CEP</th>
                                        <th className="p-3">UC</th>
                                        <th className="p-3 text-center">MEDIA_CONSUMO</th>
                                        <th className="p-3 text-center">LINK_FATURA</th>
                                        <th className="p-3 text-center">DOC_FRENTE</th>
                                        <th className="p-3 text-center">DOC_VERSO</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {loading ? (
                                        <tr><td colSpan="18" className="p-8 text-center font-bold text-emerald-600"><i className="fas fa-spinner fa-spin mr-2"></i> Inicializando Sistema Multi-Nível...</td></tr>
                                    ) : filtradosBusca.length === 0 ? (
                                        <tr><td colSpan="18" className="p-8 text-center text-slate-400">Nenhum dado encontrado para esta seleção.</td></tr>
                                    ) : (
                                        filtradosBusca.map((lead) => (
                                            <tr key={lead.id} className={`hover:bg-emerald-50 text-[11px] text-slate-700 ${lead.STATUS_CADASTRO === 'INATIVO' ? 'bg-slate-50 opacity-70' : 'bg-white'}`}>
                                                <td className="p-3 sticky left-0 shadow-[1px_0_0_#f1f5f9] text-center" style={{ backgroundColor: 'inherit' }}>
                                                    <button onClick={() => setLeadToDelete(lead)} className="text-red-500 hover:text-white bg-red-50 hover:bg-red-500 p-2 rounded-lg transition-colors shadow-sm" title="Excluir Definitivamente"><i className="fas fa-trash-alt"></i></button>
                                                </td>
                                                <td className="p-3 font-mono font-bold text-[9px] text-slate-500">{formatDate(lead.DATA_PROCESSAMENTO || lead.data_criacao || lead.DATA_ULTIMA_ATUALIZACAO)}</td>
                                                <td className="p-3">
                                                    {lead.STATUS_CADASTRO === 'INATIVO'
                                                        ? <span className="bg-slate-200 text-slate-500 px-2 py-1 rounded-md font-bold text-[9px]"><i className="fas fa-user-slash mr-1"></i> INATIVO</span>
                                                        : lead.LINK_FATURA && lead.LINK_DOC_FRENTE
                                                        ? <span className="bg-emerald-100 text-emerald-800 px-2 py-1 rounded-md font-bold text-[9px]"><i className="fas fa-check mr-1"></i> 100% COMPLETO</span>
                                                        : <span className="bg-amber-100 text-amber-800 px-2 py-1 rounded-md font-bold text-[9px]"><i className="fas fa-clock mr-1"></i> PENDENTE</span>
                                                    }
                                                </td>
                                                <td className="p-3 font-bold text-emerald-700 bg-emerald-50/50">{lead.CODIGO_CLIENTE || "-"}</td>
                                                <td className={`p-3 font-bold ${lead.STATUS_CADASTRO === 'INATIVO' ? 'text-slate-400 line-through' : 'text-slate-900'}`}>{lead.NOME_CLIENTE || "-"}</td>
                                                <td className="p-3 font-mono font-bold text-slate-600">{lead.DATA_NASCIMENTO || "-"}</td>
                                                <td className="p-3 font-mono text-slate-600">{lead.CPF || "-"}</td>
                                                <td className="p-3 font-mono text-blue-600">{lead.TELEFONE || lead.telefone || "-"}</td>
                                                <td className="p-3 font-bold text-indigo-700 bg-indigo-50/50"><i className="fas fa-id-badge mr-1 opacity-50"></i> {lead.DONO_REDE || "-"}</td>
                                                <td className="p-3 text-center font-bold text-blue-700 bg-blue-50/30 uppercase">{lead.CONTA_MES || "-"}</td>
                                                <td className="p-3 text-center font-bold text-red-600 bg-red-50/30">{lead.VENCIMENTO || "-"}</td>
                                                <td className="p-3 font-bold text-blue-600 text-[10px]">{lead.EMAIL || "-"}</td>
                                                <td className="p-3 font-mono text-slate-500">{lead.CEP || "-"}</td>
                                                <td className="p-3 font-bold text-indigo-600">{lead.UC || "-"}</td>
                                                <td className="p-3 text-center font-black text-emerald-600 text-sm bg-emerald-50">{lead.MEDIA_CONSUMO || "0"}</td>
                                                <td className="p-3 text-center">{lead.LINK_FATURA ? <a href={lead.LINK_FATURA} target="_blank" className="text-blue-500 hover:text-blue-700"><i className="fas fa-file-pdf text-lg"></i></a> : "-"}</td>
                                                <td className="p-3 text-center">{lead.LINK_DOC_FRENTE ? <a href={lead.LINK_DOC_FRENTE} target="_blank" className="text-orange-500 hover:text-orange-700"><i className="fas fa-id-card text-lg"></i></a> : "-"}</td>
                                                <td className="p-3 text-center">{lead.LINK_DOC_VERSO ? <a href={lead.LINK_DOC_VERSO} target="_blank" className="text-orange-500 hover:text-orange-700"><i className="fas fa-id-card text-lg"></i></a> : "-"}</td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </main>
                </div>
            );
        }

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(<App />);
    </script>
</body>
</html>
