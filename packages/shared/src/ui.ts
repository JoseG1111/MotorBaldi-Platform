/** Shared MotorBaldi application UI. Brand provenance: docs/ai/UX_EVIDENCE.md. */
export const uiStyles = `
:root{--brand:#d7192d;--brand-hover:#a70d1d;--nav:#080b0d;--nav-raised:#13181c;--ink:#17191b;--muted:#62676b;--canvas:#f3f1ec;--surface:#fff;--surface-soft:#f7f7f4;--line:#d1cec7;--success:#216443;--danger:#a70d1d;--warning:#805b12;--focus:#a70d1d;--radius:8px;--radius-sm:5px;--shadow:0 8px 28px #080b0d12;--sidebar:232px;--header:72px;--control:44px;--row:52px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:24px;--space-8:32px;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:var(--ink);background:var(--canvas);font-size:14px;line-height:1.5}
*{box-sizing:border-box}body{margin:0}button,input,select,textarea{font:inherit}button,a,input,select,textarea{touch-action:manipulation}button{min-height:var(--control);padding:10px 16px;border:1px solid transparent;border-radius:var(--radius-sm);background:var(--brand);color:#fff;font-weight:600;cursor:pointer}button:hover{background:var(--brand-hover)}button:disabled{cursor:not-allowed;opacity:.55}button.secondary{background:var(--surface);color:var(--ink);border-color:var(--line)}button.secondary:hover{background:var(--surface-soft)}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--focus);outline-offset:3px}input,select,textarea{min-height:var(--control);min-width:0;width:100%;padding:10px 12px;border:1px solid #94948e;border-radius:var(--radius-sm);background:var(--surface);color:var(--ink)}textarea{min-height:94px;resize:vertical}input[type=checkbox],input[type=radio]{width:20px;min-height:20px;accent-color:var(--brand)}label{display:grid;gap:6px;font-weight:600;font-size:13px}label:has(input[type=checkbox]){display:flex;align-items:center}form{display:grid;gap:16px;max-width:720px;margin:20px 0}form>button{justify-self:start}h1,h2,h3,h4{line-height:1.25;letter-spacing:-.025em}h2{font-size:28px;margin:0 0 12px;font-weight:650}h3{font-size:18px;margin:28px 0 16px}h4{font-size:14px;margin:24px 0 12px}p{margin:8px 0;overflow-wrap:anywhere}a{color:var(--brand-hover)}.muted,.page-description{color:var(--muted)}.hidden,[hidden]{display:none!important}.skip-link{position:fixed;top:-80px;left:16px;z-index:100;background:#fff;padding:12px}.skip-link:focus{top:12px}
.app-header{height:var(--header);position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:20px;background:var(--nav);color:#fff;padding:0 24px;border-bottom:1px solid #303539}.brand-lockup{text-decoration:none;display:flex;align-items:center;gap:12px;min-width:184px}.brand-lockup img{width:112px;height:46px;object-fit:contain}.brand-lockup span{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#c9cdcf;border-left:1px solid #454a4e;padding-left:12px}.app-header h1{font-size:15px;margin:0;font-weight:500}.header-context{color:#c9cdcf;font-size:12px;margin-left:auto}.icon-button{background:transparent;border:1px solid #454a4e;padding:10px;min-width:44px;display:inline-flex;align-items:center;justify-content:center}.icon-button:hover{background:#303539}.icon{width:20px;height:20px;flex-shrink:0}.app-sidebar{position:fixed;top:var(--header);bottom:0;left:0;width:var(--sidebar);background:var(--nav);padding:20px 12px;overflow-y:auto;z-index:25;display:flex;flex-direction:column;gap:4px}.nav-heading{font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:.12em;color:#a8afb4;padding:20px 12px 8px}.nav-heading:first-child{padding-top:4px}.app-sidebar button{display:flex;align-items:center;gap:12px;text-align:left;flex-shrink:0;width:100%;background:transparent;color:#c9cdcf;font-size:13px;font-weight:500;padding:10px 12px;border-left:3px solid transparent}.app-sidebar button:hover{background:var(--nav-raised);color:#fff}.app-sidebar button[aria-current=page]{background:#2d171c;border-left-color:var(--brand);color:#fff}.app-sidebar button:focus-visible,.app-header button:focus-visible,.app-header a:focus-visible{outline-color:#fff}.app-sidebar #logout{margin-top:auto;border-top:1px solid #303539;border-radius:0;padding-top:16px}.app-sidebar .nav-footer{color:#a8afb4;font-size:10px;padding:16px 12px 0}.workspace:focus-visible{outline:none}.workspace{padding:28px 32px 48px;max-width:none;min-width:0;margin:0}.signed-in .workspace{margin-left:var(--sidebar)}body:not(.signed-in) .app-sidebar,body:not(.signed-in) #nav-toggle{display:none}.breadcrumbs{color:var(--muted);font-size:12px;margin-bottom:16px}.breadcrumbs span{padding:0 8px;color:#94948e}.workspace section{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:24px;margin:0 0 24px;min-width:0}.workspace section section{padding:20px;margin:16px 0}.workspace section>h2+p{color:var(--muted);max-width:850px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:24px}.grid>*{min-width:0}.card{padding:16px;border:1px solid var(--line);border-radius:var(--radius-sm);margin:8px 0;background:var(--surface)}.card p:first-child{font-weight:600}.card p:not(:first-child){font-size:13px;color:var(--muted)}.card button{margin:8px 8px 0 0}.card:has(button){border-left:3px solid var(--line)}#notice{position:sticky;top:84px;z-index:20;padding:14px 18px;background:#fff7e5;border:1px solid #b59c66;border-radius:var(--radius-sm);color:#624608;margin:0 0 20px;box-shadow:var(--shadow)}#notice:empty{display:none}#login,#denied,#accept-invitation{max-width:520px;margin:40px auto;padding:32px}#login h2:before{content:'MOTORBALDI / ACCESO SEGURO';display:block;color:var(--brand);font-size:10px;letter-spacing:.12em;margin-bottom:20px}#login form>button{width:100%}#signup-section{border-top:1px solid var(--line);margin-top:28px}#discovery-panel{margin-bottom:24px}.signed-in #private>section:not(.hidden){animation:none}.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:end;max-width:none;padding:16px 0;margin:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.toolbar label{min-width:180px;flex:1}.toolbar button{flex:none}.data-scroll{max-width:100%;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-sm)}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}caption{text-align:left;padding:12px 16px;color:var(--muted);font-size:12px}th{background:var(--surface-soft);font-size:11px;letter-spacing:.025em;font-weight:650;color:var(--muted);white-space:nowrap}th,td{padding:12px 16px;border-bottom:1px solid var(--line);height:var(--row);vertical-align:middle}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#faf9f6}td:first-child{font-weight:600}td .record-link{padding:0;background:none;color:var(--brand-hover);text-align:left;font-weight:650}td .record-link:hover{text-decoration:underline}.identity{display:flex;align-items:center;gap:12px}.avatar{display:grid;place-items:center;min-width:34px;height:34px;border-radius:50%;background:var(--canvas);color:var(--muted);font-size:11px}.badge{display:inline-block;border:1px solid var(--line);background:var(--surface-soft);border-radius:4px;padding:3px 8px;font-size:11px;white-space:nowrap;font-weight:600}.badge.success{color:var(--success);background:#edf6ee;border-color:#bdd6c4}.badge.warning{color:var(--warning);background:#fff7e5;border-color:#e5d4ad}.badge.danger{color:var(--danger);background:#fff0f1;border-color:#edc6cc}.pagination{display:flex;gap:12px;align-items:center;justify-content:flex-end;padding:16px 0;color:var(--muted);font-size:12px}.pagination p{margin-right:auto}.empty-state{padding:40px 24px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:var(--radius-sm)}.empty-state strong{display:block;color:var(--ink);font-size:16px;margin-bottom:8px}.detail-panel:not(:empty){border-top:3px solid var(--brand);margin-top:28px;padding-top:20px;scroll-margin-top:100px}.record-open>.workflow-disclosure,.record-open>#garage-list,.record-open>#vehicle-list,.record-open>#workshop-list,.record-open>#inspection-list,.record-open>.toolbar,.record-open>#people-list,.record-open>#organization-list,.record-open>#lead-list{display:none}.detail-panel{scroll-margin-top:calc(var(--header) + 16px)}.record-open>.detail-panel{border-top:1px solid var(--line);margin-top:20px}.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:20px}.detail-grid section{margin:0}.detail-grid h4{margin-top:0}.page-description{margin-bottom:20px}.section-kicker{text-transform:uppercase;color:var(--muted);font-size:10px;font-weight:650;letter-spacing:.12em;margin-bottom:8px}.workspace section.workspace-switcher{max-width:460px;background:transparent;border:0;padding:0;margin-bottom:20px}.workspace-switcher label{display:flex;align-items:center;gap:12px;white-space:nowrap}.workspace-switcher select{min-width:190px}#organization-list{display:flex;gap:8px;flex-wrap:wrap}#organization-list:has(table){display:block}.workspace-switcher select{font-weight:600}.nav-collapsed{--sidebar:76px}.nav-collapsed .nav-label,.nav-collapsed .nav-heading,.nav-collapsed .nav-footer{display:none}.nav-collapsed .app-sidebar button{justify-content:center;padding:10px}.nav-collapsed .app-sidebar{padding:16px 8px}.nav-scrim{display:none}details{border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px 16px;margin:16px 0}summary{cursor:pointer;font-weight:600;min-height:32px;padding:4px 0}details[open]>summary{border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:16px}dialog{border:1px solid var(--line);border-radius:var(--radius);padding:28px;max-width:min(540px,calc(100vw - 32px));box-shadow:var(--shadow)}dialog::backdrop{background:#080b0d80}dialog form{margin-bottom:0}.dialog-actions{display:flex;justify-content:flex-end;gap:12px}
.row-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.inspection-report>h3{margin-top:0}.inspection-report{margin:16px 0}.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.summary-grid .card p:first-child{font-size:13px}.summary-grid .card{background:var(--surface-soft)}.workflow-disclosure>form{max-width:840px}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}.metric{padding:16px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-soft)}.metric strong{display:block;font-size:28px;line-height:1.3;font-variant-numeric:tabular-nums}.report-meta{font-size:12px;color:var(--muted);padding:12px 0}.report-meta p{margin:4px 0}.metric p{font-weight:600}.metric span{font-size:12px;color:var(--muted)}.record-summary{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:20px 0;border-bottom:1px solid var(--line)}.action-bar{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px;max-width:none}.work-queue{display:grid;gap:12px}.queue-item{padding:20px;border:1px solid var(--line);border-left:3px solid var(--brand);border-radius:var(--radius-sm)}.report-findings{border-left:2px solid var(--line);padding-left:20px;margin-top:20px}.report-findings .card{border:0;border-bottom:1px solid var(--line);padding:12px 0}.detail-grid .card{border:0;border-bottom:1px solid var(--line);border-radius:0;padding:8px 0;margin:0}.detail-grid section{margin:0!important}.detail-grid{margin:20px 0}td{padding-top:4px;padding-bottom:4px}.data-scroll .record-link{min-height:44px}.workspace [id$='-detail']:empty{display:none}
@media(min-width:769px){.toolbar input[name=q]{min-width:240px}#people-panel,#organizations-panel{min-height:520px}}
@media(max-width:1024px){.workspace{padding:24px}.app-header{padding:0 16px;gap:12px}.header-context{display:none}.brand-lockup{min-width:160px}.grid{gap:16px}}
@media(max-width:768px){:root{--sidebar:232px;--header:64px}.signed-in .workspace{margin-left:0}.workspace{padding:16px}.app-sidebar{display:none;width:272px}.nav-open .app-sidebar{display:flex}.nav-open .nav-scrim{display:block;position:fixed;inset:var(--header) 0 0;background:#080b0d70;z-index:24;border:0;border-radius:0;width:100%}.nav-collapsed .nav-label,.nav-collapsed .nav-heading{display:block}.nav-collapsed .app-sidebar button{justify-content:flex-start;padding:10px 12px}.app-header h1{font-size:12px}.brand-lockup{min-width:0}.brand-lockup span{display:none}.brand-lockup img{width:90px;height:40px}.workspace section{padding:20px;margin-bottom:16px}h2{font-size:24px}h3{font-size:17px}.toolbar{align-items:stretch}.toolbar label{min-width:100%}.toolbar button{width:100%}form{max-width:none}.pagination{flex-wrap:wrap}.pagination p{width:100%}#login{margin:16px auto;padding:24px}.breadcrumbs{margin-bottom:12px}th,td{padding:10px 12px}.data-scroll{border-right:2px solid var(--line)}.app-header{gap:10px}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

const paths: Record<string, string> = {
  people:
    '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/>',
  organizations:
    '<path d="M4 21V3h12v18M16 9h4v12M8 7h4m-4 4h4m-4 4h4M2 21h20"/>',
  vehicles:
    '<path d="m3 11 2-6h14l2 6v8h-3v-3H6v3H3v-8Zm0 0h18M6 13h2m8 0h2"/>',
  crm: '<path d="M4 4h16v16H4zM8 8h8m-8 4h5m-5 4h8"/>',
  workshop: '<path d="m14 5 5-3-1 6-4 2-8 11-4-4 10-9V3z"/>',
  billing:
    '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  parts:
    '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10 9-5M3 7l9 5v10M7 4l10 5"/>',
  support:
    '<path d="M4 13v-1a8 8 0 0 1 16 0v5h-4v-6h4M4 11h4v6H4v-6Zm16 6v3h-8"/>',
  account:
    '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  notifications: '<path d="M5 17h14l-2-4V8a5 5 0 0 0-10 0v5l-2 4Zm5 3h4"/>',
  analytics: '<path d="M4 3v18h17M8 16v-4m5 4V6m5 10V9"/>',
  inspections: '<path d="M8 3h8v4H8zM8 5H4v17h16V5h-4M8 13l3 3 5-6"/>',
  logout: '<path d="M10 4H4v16h6m4-12 4 4-4 4m-5-4h12"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
};
export function uiIcon(name: string) {
  return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.inspections}</svg>`;
}
export function applicationPage(html: string, mode: "admin" | "portal") {
  const admin = mode === "admin";
  const groups: Record<string, string> = admin
    ? {
        people: "Relaciones",
        verifications: "Confianza",
        vehicles: "Operaciones",
        billing: "Comercial",
        support: "Gestión",
      }
    : {
        garage: "Mi vehículo",
        discovery: "Explorar",
        organizations: "Mi organización",
        mechanic: "Profesional",
        account: "Mi cuenta",
      };
  return html
    .replace(/<style>[\s\S]*?<\/style>/, `<style>${uiStyles}</style>`)
    .replace(
      /<header>[\s\S]*?<\/header>/,
      `<a class="skip-link" href="#workspace-main">Saltar al contenido</a><header class="app-header"><button id="nav-toggle" class="icon-button" aria-label="Contraer navegación" aria-controls="app-navigation" aria-expanded="true">${uiIcon("menu")}</button><a class="brand-lockup" href="/" aria-label="MotorBaldi, inicio"><img src="/brand/logo.webp" alt="MotorBaldi" width="112" height="46"><span>${admin ? "Administración" : "Mi espacio"}</span></a><h1 id="workspace-title">${admin ? "Administración MotorBaldi" : "Todo sobre tu vehículo"}</h1><span class="header-context">${admin ? "Gestión de la plataforma" : "Siempre contigo."}</span></header>`,
    )
    .replace(
      "<main>",
      `<main class="workspace" id="workspace-main" tabindex="-1"><div class="breadcrumbs">MotorBaldi <span>/</span> ${admin ? "Administración" : "Mi espacio"} <span>/</span> <b id="current-section">Inicio</b></div>`,
    )
    .replace(
      /<nav aria-label="([^"]+)">([\s\S]*?)<\/nav>/,
      (_match, label: string, buttons: string) => {
        if (!admin) {
          const all = [...buttons.matchAll(/<button([^>]*)>[^<]+<\/button>/g)];
          const order = [
            "garage",
            "membership",
            "notifications",
            "support",
            "discovery",
            "organizations",
            "workshop",
            "inspections",
            "parts",
            "mechanic",
            "account",
            "logout",
          ];
          buttons = order
            .map(
              (panel) =>
                all.find((match) =>
                  panel === "logout"
                    ? match[1]?.includes('id="logout"')
                    : match[1]?.includes('data-panel="' + panel + '"'),
                )?.[0] ?? "",
            )
            .join("");
        }
        const items = buttons.replace(
          /<button([^>]*)>([^<]+)<\/button>/g,
          (_button, attributes: string, text: string) => {
            const panel =
              /data-panel="([^"]+)"/.exec(attributes)?.[1] ?? "logout";
            const icon =
              (
                {
                  garage: "vehicles",
                  discovery: "parts",
                  membership: "billing",
                  mechanic: "account",
                  commissions: "billing",
                  professionals: "account",
                } as Record<string, string>
              )[panel] ?? panel;
            return `${groups[panel] ? `<div class="nav-heading">${groups[panel]}</div>` : ""}<button${attributes} title="${text}" aria-label="${text}">${uiIcon(icon)}<span class="nav-label">${text}</span></button>`;
          },
        );
        return `<button class="nav-scrim" aria-label="Cerrar navegación" tabindex="-1"></button><nav class="app-sidebar" id="app-navigation" aria-label="${label}">${items}<div class="nav-footer">MOTORBALDI · SIEMPRE CONTIGO</div></nav>`;
      },
    );
}

/** Runs only in a real DOM; VM domain tests intentionally use a minimal DOM. */
export const shellScript = `
if(document.documentElement && typeof MutationObserver!=='undefined'){
 const nav=document.getElementById('app-navigation'),toggle=document.getElementById('nav-toggle'),privateRoot=document.getElementById('private');
 const mobile=()=>matchMedia('(max-width:768px)').matches;
 const closeNav=()=>{document.body.classList.remove('nav-open');toggle.setAttribute('aria-expanded',String(!mobile()&&!document.body.classList.contains('nav-collapsed')))};
 toggle.onclick=()=>{if(mobile())document.body.classList.toggle('nav-open');else document.body.classList.toggle('nav-collapsed');toggle.setAttribute('aria-expanded',String(mobile()?document.body.classList.contains('nav-open'):!document.body.classList.contains('nav-collapsed')));toggle.setAttribute('aria-label',toggle.getAttribute('aria-expanded')==='true'?'Contraer navegación':'Abrir navegación');if(mobile()&&document.body.classList.contains('nav-open'))nav.querySelector('button:not(.hidden)')?.focus()};
 document.querySelector('.nav-scrim').onclick=()=>{closeNav();toggle.focus()};
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('nav-open')){closeNav();toggle.focus()}if(event.key==='Tab'&&mobile()&&document.body.classList.contains('nav-open')){const nodes=[toggle,...nav.querySelectorAll('button:not(.hidden)')].filter(el=>el.getClientRects().length);if(event.shiftKey&&document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1).focus()}else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();toggle.focus()}}});
 nav.addEventListener('click',event=>{if(event.target.closest('[data-panel]')){document.body.classList.remove('show-discovery');closeNav();document.getElementById('workspace-main').focus({preventScroll:true})}});
 const sync=()=>{const signed=!privateRoot.classList.contains('hidden');document.body.classList.toggle('signed-in',signed);let current=null;for(const button of nav.querySelectorAll('[data-panel]')){const panel=document.getElementById(button.dataset.panel+'-panel');const active=signed&&panel&&!panel.classList.contains('hidden')&&!button.classList.contains('hidden');if(active){button.setAttribute('aria-current','page');current=button.querySelector('.nav-label').textContent}else button.removeAttribute('aria-current')}for(const heading of nav.querySelectorAll('.nav-heading')){let next=heading.nextElementSibling,visible=false;while(next&&!next.classList.contains('nav-heading')){if(next.matches('[data-panel]')&&!next.classList.contains('hidden'))visible=true;next=next.nextElementSibling}heading.hidden=!visible}if(current){document.getElementById('current-section').textContent=current;document.getElementById('workspace-title').textContent=current;document.title=current+' | MotorBaldi'}else if(!signed){document.getElementById('current-section').textContent='Acceso';document.getElementById('workspace-title').textContent='MotorBaldi'}};
 new MutationObserver(sync).observe(privateRoot,{subtree:true,attributes:true,attributeFilter:['class']});sync();closeNav();
 matchMedia('(max-width:768px)').addEventListener('change',closeNav);
}
`;

export const uiRuntime = `
function uiError(error){if(error instanceof TypeError||error instanceof SyntaxError||/undefined|null|is not a function|JSON|fetch|NetworkError|Failed to fetch|Cannot |can't access/i.test(error?.message||''))return 'No pudimos cargar la información. Vuelve a intentarlo. Si el problema continúa, contacta con soporte.';return error?.message||'No fue posible completar la acción. Inténtalo de nuevo.'}
function uiAmountMinor(value){const parts=String(value).trim().split('.');if(parts.length>2||!/^[0-9]+$/.test(parts[0])||(parts[1]!==undefined&&!/^[0-9]{1,2}$/.test(parts[1])))throw new Error('Indica un precio en pesos con un máximo de dos decimales.');const minor=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));if(!Number.isSafeInteger(minor)||minor<0)throw new Error('El precio está fuera del rango permitido.');return String(minor)}
function uiRows(value){if(!Array.isArray(value)||value.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new Error('La respuesta del servicio no tiene el formato esperado. Vuelve a intentarlo.');return value}
function uiPage(value){if(!value||!Array.isArray(value.items)||!(value.nextCursor==null||typeof value.nextCursor==='string'))throw new Error('La respuesta del servicio no tiene el formato esperado. Vuelve a intentarlo.');uiRows(value.items);return value}
function uiValidate(path,data){const route=path.split('?')[0];if(['/admin/people','/admin/organizations','/admin/crm/leads','/admin/vehicles','/admin/workshop/orders','/admin/inspections','/me/garage'].includes(route)){uiPage(data);if(data.items.some(row=>typeof row.id!=='string'||!row.id))throw new Error('La respuesta del servicio no tiene el formato esperado. Vuelve a intentarlo.')}if(route==='/admin/commissions'){uiRows(data?.agreements);uiRows(data?.entries)}if(route==='/admin/billing'){uiRows(data?.subscriptions);uiRows(data?.payments)}if(route==='/admin/access'&&(!data||!Array.isArray(data.permissions)||data.permissions.some(p=>typeof p!=='string')))throw new Error('No fue posible verificar los permisos de tu cuenta.');return data}
function uiEmpty(root,title='No hay registros para mostrar.',description='Prueba otra búsqueda o vuelve a consultar más tarde.'){const box=document.createElement('div');box.className='empty-state';const h=document.createElement('strong');h.textContent=title;const p=document.createElement('p');p.textContent=description;box.append(h,p);root.append(box)}
function uiBadge(value,text){const span=document.createElement('span');span.className='badge '+(['ACTIVE','VERIFIED','APPROVED','PAID','FINAL','COMPLETED','PUBLISHED'].includes(value)?'success':['REJECTED','SUSPENDED','FAILED'].includes(value)?'danger':['PENDING','PENDING_VERIFICATION','OPEN','IN_PROGRESS','PENDING_ACTIVATION'].includes(value)?'warning':'');span.textContent=text||value||'Sin registro';return span}
function uiTable(root,columns,rows,caption){const scroll=document.createElement('div');scroll.className='data-scroll';scroll.setAttribute?.('tabindex','0');scroll.setAttribute?.('role','region');scroll.setAttribute?.('aria-label',caption);const table=document.createElement('table');const cap=document.createElement('caption');cap.textContent=caption;table.append(cap);const head=document.createElement('thead'),tr=document.createElement('tr');for(const column of columns){const th=document.createElement('th');th.setAttribute?.('scope','col');th.textContent=column.title;tr.append(th)}head.append(tr);table.append(head);const body=document.createElement('tbody');for(const row of rows){const tr=document.createElement('tr');for(const column of columns){const td=document.createElement('td');const value=column.render(row);if(value&&typeof value==='object')td.append(value);else td.textContent=value??'—';tr.append(td)}body.append(tr)}table.append(body);scroll.append(table);root.append(scroll);if(!rows.length)uiEmpty(root);return table}
function uiRecord(name,action){const box=document.createElement('div');box.className='identity';const avatar=document.createElement('span');avatar.className='avatar';avatar.setAttribute?.('aria-hidden','true');avatar.textContent=String(name).split(' ').filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase();const button=document.createElement('button');button.className='record-link';button.textContent=name;button.onclick=()=>Promise.resolve().then(action).catch(error=>notice(uiError(error)));box.append(avatar,button);return box}
function uiDate(value){if(!value)return 'Sin fecha';const date=new Date(value);return Number.isNaN(date.getTime())?'Sin fecha':new Intl.DateTimeFormat('es-CO',{dateStyle:'medium'}).format(date)}
function uiDetail(root,title){root.closest?.('section')?.classList.add('record-open');root.className='detail-panel';root.setAttribute?.('tabindex','-1');const close=document.createElement('button');close.className='secondary';close.textContent='Volver a la lista';close.onclick=()=>{root.closest?.('section')?.classList.remove('record-open');root.replaceChildren();root.previousElementSibling?.querySelector('button')?.focus()};const heading=document.createElement('h3');heading.textContent=title;root.append(close,heading);root.focus?.({preventScroll:true});root.scrollIntoView?.({behavior:'instant',block:'start'})}
`;
