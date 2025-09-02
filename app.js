
// Client-side SQLite via sql.js (WASM).
// We fetch a DB file (default: data/residencial.db). If not present, we fall back to /data/residencial_sample.db.
// Admin can also click "Cargar BD" to load any .db from their computer (created with DB Browser for SQLite).

const SQL_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2";

let SQL;
let db; // current Database instance (in-memory)
let dbBytes; // Uint8Array for persistence across pages (optional)

async function initSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs({
    locateFile: (file) => `${SQL_CDN}/${file}`
  });
  return SQL;
}

async function loadDB(preferredUrl = "data/residencial.db") {
  await initSql();
  try {
    const res = await fetch(preferredUrl);
    if (!res.ok) throw new Error("DB not found at " + preferredUrl);
    const buf = await res.arrayBuffer();
    dbBytes = new Uint8Array(buf);
    db = new SQL.Database(dbBytes);
    console.info("DB loaded from", preferredUrl);
  } catch (e) {
    // fallback to sample
    const res = await fetch("data/residencial_sample.db");
    const buf = await res.arrayBuffer();
    dbBytes = new Uint8Array(buf);
    db = new SQL.Database(dbBytes);
    console.warn("Using sample DB (data/residencial_sample.db). Place your DB at data/residencial.db to use real data.");
  }
}

async function handleFileDB(file) {
  const buf = await file.arrayBuffer();
  dbBytes = new Uint8Array(buf);
  db = new SQL.Database(dbBytes);
  alert("Base de datos cargada desde archivo: " + file.name);
  // Trigger a re-render on current page:
  const page = document.body.dataset.page;
  if (page === "home") renderHome();
  if (page === "calendar") renderCalendar();
  if (page === "tenants") renderTenants();
}

// ---------- Utilities ----------
function q(sel, root=document){ return root.querySelector(sel); }
function qa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

function fmtDate(iso){
  if(!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) {
    // Try split
    const [y,m,day]= iso.split("-");
    return `${day}/${m}/${y}`;
  }
  return d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'2-digit' });
}

function monthName(mIndex){
  return new Date(2000, mIndex, 1).toLocaleString(undefined, { month: 'long'});
}

function zeroPad(n){ return n.toString().padStart(2, "0"); }

function parseMonthValue(val){ // "2025-08" -> {year:2025, month:8}
  const [y, m] = val.split("-").map(Number);
  return {year:y, month:m};
}

// ---------- Render: Home (Noticias) ----------
function renderHome(){
  const list = q("#news-list");
  if(!db || !list) return;

  const stmt = db.prepare(`
    SELECT Fecha, Noticia
    FROM Noticias
    ORDER BY date(Fecha) DESC
    LIMIT 3
  `);

  let html = "";
  while(stmt.step()){
    const row = stmt.getAsObject();
    html += `
      <li class="card">
        <time datetime="${row.Fecha}">${fmtDate(row.Fecha)}</time>
        <div>${row.Noticia}</div>
      </li>
    `;
  }
  stmt.free();
  list.innerHTML = html || `<li class="card">No hay noticias registradas.</li>`;
}

// ---------- Render: Calendar ----------
function buildCalendarMatrix(year, month){
  // month: 1..12
  const first = new Date(year, month-1, 1);
  const startDay = first.getDay(); // 0 Sun ... 6 Sat
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  // Fill leading blanks
  for(let i=0;i<startDay;i++) cells.push(null);
  // Fill actual days
  for(let d=1; d<=daysInMonth; d++) cells.push(d);
  return { cells, daysInMonth, startDay };
}

function fetchEvents(year, month){
  const m = zeroPad(month);
  const y = String(year);
  const stmt = db.prepare(`
    SELECT Fecha, Titulo, Descripcion
    FROM Calendario
    WHERE strftime('%m', Fecha)=? AND strftime('%Y', Fecha)=?
    ORDER BY date(Fecha) ASC, Titulo ASC
  `);
  stmt.bind([m, y]);
  const eventsByDay = {};
  while(stmt.step()){
    const r = stmt.getAsObject();
    const day = Number(r.Fecha.split("-")[2]);
    if(!eventsByDay[day]) eventsByDay[day] = [];
    eventsByDay[day].push(r);
  }
  stmt.free();
  return eventsByDay;
}

function renderCalendar(){
  const out = q("#calendar-grid");
  const monthInput = q("#month");
  if(!db || !out || !monthInput) return;

  const {year, month} = parseMonthValue(monthInput.value);
  const {cells} = buildCalendarMatrix(year, month);
  const events = fetchEvents(year, month);

  // Header (Mon-Sun or Sun-Sat – we keep Sun first for simplicity)
  const heads = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"]
    .map(h=>`<div class="head">${h}</div>`).join("");

  const days = cells.map(d=>{
    if(d===null) return `<div class="day"></div>`;
    const evts = (events[d]||[]).map((e,i)=>{
      const id = `evt-${year}-${month}-${d}-${i}`;
      return `<button class="tag" data-evt='${JSON.stringify(e).replaceAll("'", "&apos;")}' aria-controls="evt-dialog">
        ${e.Titulo}
      </button>`;
    }).join("");
    return `<div class="day"><div class="day-num">${d}</div><div class="events">${evts}</div></div>`;
  }).join("");

  out.innerHTML = heads + days;

  // Click handlers for events -> show dialog
  qa(".tag", out).forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const e = JSON.parse(btn.getAttribute("data-evt").replaceAll("&apos;", "'"));
      const dlg = q("#evt-dialog");
      q("#dlg-title").textContent = e.Titulo;
      q("#dlg-date").textContent = fmtDate(e.Fecha);
      q("#dlg-desc").textContent = e.Descripcion || "";
      dlg.showModal();
    });
  });

  q("#month-label").textContent = `${monthName(month)} ${year}`;
}

// ---------- Render: Tenants (Consulta de Inquilinos) ----------
function validateTenantForm(fd){
  const dpi = fd.get("dpi")?.trim();
  const casa = Number(fd.get("casa"));
  const nombre = fd.get("nombre")?.trim();
  const apellido = fd.get("apellido")?.trim();
  const nacimiento = fd.get("nacimiento");

  // Basic checks
  if(!/^\d{13}$/.test(dpi)) return {ok:false, msg:"DPI debe tener 13 dígitos."};
  if(!casa || casa<=0) return {ok:false, msg:"Número de casa inválido."};
  if(!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'-]{2,}$/.test(nombre)) return {ok:false, msg:"Primer nombre inválido."};
  if(!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'-]{2,}$/.test(apellido)) return {ok:false, msg:"Primer apellido inválido."};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(nacimiento)) return {ok:false, msg:"Fecha de nacimiento inválida."};
  return {ok:true};
}

function findTenant(fd){
  const stmt = db.prepare(`
    SELECT DPI, PrimerNombre, PrimerApellido, FechaNacimiento, NumeroCasa
    FROM Inquilino
    WHERE DPI=? AND NumeroCasa=? AND PrimerNombre LIKE ? AND PrimerApellido LIKE ? AND FechaNacimiento=?
  `);
  const nombre = fd.get("nombre").trim();
  const apellido = fd.get("apellido").trim();
  const dpi = fd.get("dpi").trim();
  const casa = Number(fd.get("casa"));
  const nacimiento = fd.get("nacimiento");
  stmt.bind([dpi, casa, nombre, apellido, nacimiento]);
  const found = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return found;
}

function isCurrentMonthPaid(casa){
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth()+1;
  const stmt = db.prepare(`
    SELECT 1 FROM PagoDeCuotas
    WHERE NumeroCasa=? AND AnoCuota=? AND MesCuota=?
    LIMIT 1
  `);
  stmt.bind([casa, y, m]);
  const paid = stmt.step();
  stmt.free();
  return paid;
}

function queryHistory(casa, startYM, endYM){
  // startYM/endYM: "YYYY-MM"
  const {year:sy, month:sm} = parseMonthValue(startYM);
  const {year:ey, month:em} = parseMonthValue(endYM);
  const startKey = sy*100+sm;
  const endKey = ey*100+em;

  const stmt = db.prepare(`
    SELECT NumeroCasa, AnoCuota, MesCuota, FechaPago
    FROM PagoDeCuotas
    WHERE NumeroCasa=?
      AND (AnoCuota*100 + MesCuota) BETWEEN ? AND ?
    ORDER BY AnoCuota ASC, MesCuota ASC
  `);
  stmt.bind([casa, startKey, endKey]);
  const rows = [];
  while(stmt.step()){
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function renderTenants(){
  const form = q("#tenant-form");
  const msg = q("#tenant-msg");
  const hist = q("#history");
  if(!form) return;

  form.addEventListener("submit", (e)=>{
    e.preventDefault();
    msg.textContent = "";
    msg.className = "helper";

    const fd = new FormData(form);
    const v = validateTenantForm(fd);
    if(!v.ok){
      msg.textContent = v.msg;
      msg.className = "helper status-bad";
      return;
    }

    const tenant = findTenant(fd);
    if(!tenant){
      msg.textContent = "Datos no coinciden con nuestros registros.";
      msg.className = "helper status-bad";
      return;
    }

    const casa = Number(fd.get("casa"));
    if(isCurrentMonthPaid(casa)){
      msg.textContent = "Cuota de mantenimiento al día";
      msg.className = "helper status-ok";
    } else {
      msg.textContent = "Cuota de mantenimiento pendiente";
      msg.className = "helper status-bad";
    }
  });

  // History search
  q("#btn-history").addEventListener("click", ()=>{
    const casa = Number(q("#casa").value);
    const start = q("#start").value;
    const end = q("#end").value;
    if(!casa || !start || !end){
      alert("Complete número de casa y el rango de fechas (mes de inicio y fin).");
      return;
    }
    const rows = queryHistory(casa, start, end);
    const tbody = q("#history-body");
    tbody.innerHTML = rows.map(r=>`
      <tr>
        <td>${r.NumeroCasa}</td>
        <td>${r.AnoCuota}</td>
        <td>${r.MesCuota}</td>
        <td>${fmtDate(`${r.AnoCuota}-${zeroPad(r.MesCuota)}-01`)}</td>
        <td>${fmtDate(r.FechaPago)}</td>
      </tr>
    `).join("") || `<tr><td colspan="5">Sin resultados para el rango seleccionado.</td></tr>`;
    hist.style.display = "block";
  });
}

// ---------- Boot ----------
async function boot(){
  await loadDB();

  // Global "Cargar BD" button
  const uploader = q("#db-upload");
  if (uploader) {
    uploader.addEventListener("change", (e)=>{
      if(e.target.files?.[0]) handleFileDB(e.target.files[0]);
    });
  }
  const btnLoad = q("#btn-load-db");
  if (btnLoad) {
    btnLoad.addEventListener("click", ()=> q("#db-upload").click());
  }

  const page = document.body.dataset.page;
  if (page === "home") renderHome();
  if (page === "calendar") {
    const monthInput = q("#month");
    const now = new Date();
    monthInput.value = `${now.getFullYear()}-${zeroPad(now.getMonth()+1)}`;
    renderCalendar();
    monthInput.addEventListener("change", renderCalendar);
    q("#prev").addEventListener("click", ()=>{
      const {year, month} = parseMonthValue(monthInput.value);
      const d = new Date(year, month-1, 1);
      d.setMonth(d.getMonth()-1);
      monthInput.value = `${d.getFullYear()}-${zeroPad(d.getMonth()+1)}`;
      renderCalendar();
    });
    q("#next").addEventListener("click", ()=>{
      const {year, month} = parseMonthValue(monthInput.value);
      const d = new Date(year, month-1, 1);
      d.setMonth(d.getMonth()+1);
      monthInput.value = `${d.getFullYear()}-${zeroPad(d.getMonth()+1)}`;
      renderCalendar();
    });
  }
  if (page === "tenants") renderTenants();
}

document.addEventListener("DOMContentLoaded", boot);
