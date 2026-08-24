require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const OAuthClient = require("intuit-oauth");
const nodemailer = require("nodemailer");
const multer = require("multer");
const crypto = require("crypto");
const app = express();

const REPO_IMAGES_DIR = path.join(__dirname, "images", "productos");
const PERSISTENT_DATA_DIR =
  process.env.PERSISTENT_DATA_DIR || path.join(__dirname, "persistent-data");
const PERSISTENT_IMAGES_DIR = path.join(PERSISTENT_DATA_DIR, "productos");
const IMAGE_MAP_FILE = path.join(PERSISTENT_DATA_DIR, "imagenes-productos.json");
const CATEGORY_MAP_FILE = path.join(PERSISTENT_DATA_DIR, "categorias-productos.json");
const SUBFILTER_MAP_FILE = path.join(PERSISTENT_DATA_DIR, "subfiltros-productos.json");
const PRODUCTS_CACHE_FILE = path.join(PERSISTENT_DATA_DIR, "productos-qbo-cache.json");
const PRODUCTS_CACHE_TTL_MS = 60 * 1000;
const INVENTORY_FILE = path.join(PERSISTENT_DATA_DIR, "inventario.json");
const INVOICE_SYNC_FILE = path.join(PERSISTENT_DATA_DIR, "facturas-inventario-sync.json");
const QBO_INVENTORY_POLL_FILE = path.join(
  PERSISTENT_DATA_DIR,
  "qbo-inventario-ultima-revision.json"
);
// Revisa QuickBooks con frecuencia suficiente para que una factura manual se
// refleje en el inventario sin depender únicamente del webhook.
const QBO_INVENTORY_POLL_INTERVAL_MS = Math.max(
  15 * 1000,
  Number(process.env.QBO_INVENTORY_POLL_INTERVAL_MS || 30 * 1000)
);
// Si QuickBooks elimina la factura, puede dejar de devolverla en la consulta.
// Esta revisión consulta el registro local de facturas y detecta también ese caso.
const QBO_INVENTORY_RECONCILE_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.QBO_INVENTORY_RECONCILE_INTERVAL_MS || 60 * 1000)
);
const QBO_INVENTORY_POLL_START_AT = new Date().toISOString();
const OPENAI_TRANSCRIBE_MODEL = String(
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe"
).trim();
const QBO_WEBHOOK_VERIFIER_TOKEN = String(
  process.env.QBO_WEBHOOK_VERIFIER_TOKEN || ""
).trim();

fs.mkdirSync(PERSISTENT_IMAGES_DIR, { recursive: true });

function leerMapaImagenes() {
  try {
    if (!fs.existsSync(IMAGE_MAP_FILE)) return {};
    return JSON.parse(fs.readFileSync(IMAGE_MAP_FILE, "utf8"));
  } catch (error) {
    console.error("Error leyendo mapa de imágenes:", error);
    return {};
  }
}

function guardarMapaImagenes(mapa) {
  fs.writeFileSync(IMAGE_MAP_FILE, JSON.stringify(mapa, null, 2), "utf8");
}

function leerMapaCategorias() {
  try {
    if (!fs.existsSync(CATEGORY_MAP_FILE)) return {};
    return JSON.parse(fs.readFileSync(CATEGORY_MAP_FILE, "utf8"));
  } catch (error) {
    console.error("Error leyendo mapa de categorías:", error);
    return {};
  }
}

function guardarMapaCategorias(mapa) {
  fs.writeFileSync(CATEGORY_MAP_FILE, JSON.stringify(mapa, null, 2), "utf8");
}

function leerMapaSubfiltros() {
  try {
    if (!fs.existsSync(SUBFILTER_MAP_FILE)) return {};
    return JSON.parse(fs.readFileSync(SUBFILTER_MAP_FILE, "utf8"));
  } catch (error) {
    console.error("Error leyendo mapa de subfiltros:", error);
    return {};
  }
}

function guardarMapaSubfiltros(mapa) {
  fs.writeFileSync(SUBFILTER_MAP_FILE, JSON.stringify(mapa, null, 2), "utf8");
}

function leerInventario() {
  try {
    if (!fs.existsSync(INVENTORY_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(INVENTORY_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch (error) {
    console.error("Error leyendo inventario:", error);
    return {};
  }
}

function guardarInventario(inventario) {
  fs.writeFileSync(INVENTORY_FILE, JSON.stringify(inventario, null, 2), "utf8");
}

function claveInventario(inventario, itemId) {
  const id = String(itemId || "").trim();
  if (!id) return null;
  if (Object.prototype.hasOwnProperty.call(inventario, id)) return id;

  // QBO siempre debe mandar el mismo Id, pero toleramos espacios invisibles
  // para no perder el descuento si el registro se capturó manualmente.
  const compacto = id.replace(/\s+/g, "");
  return Object.keys(inventario).find((clave) => {
    const texto = String(clave).trim();
    return texto === id || texto.replace(/\s+/g, "") === compacto;
  }) || null;
}

function descontarInventario(items) {
  const inventario = leerInventario();
  const idsNoEncontrados = [];
  for (const item of Array.isArray(items) ? items : []) {
    const itemId = String(item.itemId || item.id || "").trim();
    const qty = Number(item.qty ?? item.quantity ?? item.cantidad ?? 0);
    if (!itemId || !Number.isFinite(qty) || qty <= 0) continue;
    const clave = claveInventario(inventario, itemId);
    if (!clave) {
      idsNoEncontrados.push(itemId);
      continue;
    }
    inventario[clave].cantidad = Math.max(0, Number(inventario[clave].cantidad || 0) - qty);
    inventario[clave].updatedAt = new Date().toISOString();
  }
  guardarInventario(inventario);
  if (idsNoEncontrados.length) {
    console.warn("INVENTARIO: IDs no encontrados al descontar:", idsNoEncontrados);
  }
  return inventario;
}

function leerSincronizacionFacturas() {
  try {
    if (!fs.existsSync(INVOICE_SYNC_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(INVOICE_SYNC_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch (error) {
    console.error("Error leyendo sincronización de facturas:", error);
    return {};
  }
}

function guardarSincronizacionFacturas(data) {
  fs.writeFileSync(INVOICE_SYNC_FILE, JSON.stringify(data, null, 2), "utf8");
}

function extraerLineasInventario(origen) {
  const lineas = Array.isArray(origen) ? origen : origen?.Line || [];
  const mapa = {};
  for (const linea of lineas) {
    const detalle = linea?.SalesItemLineDetail || linea?.salesItemLineDetail || {};
    const itemId = String(
      detalle?.ItemRef?.value ||
      detalle?.itemRef?.value ||
      linea?.ItemRef?.value ||
      linea?.itemId ||
      linea?.id ||
      ""
    ).trim();
    const cantidad = Number(
      detalle?.Qty ?? linea?.qty ?? linea?.quantity ?? linea?.cantidad ?? 0
    );
    if (!itemId || !Number.isFinite(cantidad) || cantidad <= 0) continue;
    mapa[itemId] = Number((Number(mapa[itemId] || 0) + cantidad).toFixed(4));
  }
  return mapa;
}

function facturaEstaAnulada(factura) {
  if (!factura || typeof factura !== "object") return false;
  if (factura.Void === true || String(factura.Void || "").toLowerCase() === "true") return true;
  const estados = [
    factura.TxnStatus,
    factura.invoiceStatus,
    factura.InvoiceStatus,
    factura.Status,
    factura.status,
  ];
  return estados.some((estado) => /^(void|voided|deleted|reversed|cancelled|canceled)$/i.test(String(estado || "").trim()));
}

function facturaNoEncontradaQbo(error) {
  const status = Number(error?.response?.status || 0);
  const texto = JSON.stringify(error?.response?.data || error?.message || "").toLowerCase();
  return status === 404 || ((status === 400 || status === 410) && /(not found|object not found|does not exist|deleted)/i.test(texto));
}

function aplicarDiferenciaInventario(lineasNuevas, lineasAnteriores, contexto = {}) {
  const inventario = leerInventario();
  const ids = new Set([
    ...Object.keys(lineasNuevas || {}),
    ...Object.keys(lineasAnteriores || {}),
  ]);
  const cambios = [];
  const idsNoEncontrados = [];
  for (const itemId of ids) {
    const diferencia =
      Number(lineasNuevas?.[itemId] || 0) -
      Number(lineasAnteriores?.[itemId] || 0);
    if (!diferencia) continue;
    const clave = claveInventario(inventario, itemId);
    if (!clave) {
      idsNoEncontrados.push(itemId);
      continue;
    }
    const cantidadAntes = Number(inventario[clave].cantidad || 0);
    inventario[clave].cantidad = Math.max(
      0,
      cantidadAntes - diferencia
    );
    inventario[clave].updatedAt = new Date().toISOString();
    cambios.push({
      itemId,
      cantidadFactura: Number(lineasNuevas?.[itemId] || 0),
      cantidadAnteriorFactura: Number(lineasAnteriores?.[itemId] || 0),
      diferencia,
      cantidadAntes,
      cantidadDespues: inventario[clave].cantidad,
    });
  }
  guardarInventario(inventario);
  console.log("QBO INVENTARIO RESULTADO:", JSON.stringify({
    invoiceId: contexto.invoiceId || "",
    source: contexto.source || "",
    operation: contexto.operation || "",
    cambios,
    idsNoEncontrados,
  }));
  return inventario;
}

function sincronizarFacturaInventario(invoiceId, origen, opciones = {}) {
  const id = String(invoiceId || "").trim();
  if (!id) return leerInventario();
  const lineasDelOrigen = extraerLineasInventario(origen);
  const lineasNuevas = opciones.restaurar ? {} : lineasDelOrigen;
  const sincronizadas = leerSincronizacionFacturas();
  const anterior = sincronizadas[id];

  // Si encontramos una factura antigua que solo fue editada después de activar
  // la sincronización, guardamos la base sin descontarla otra vez. Una factura
  // recién creada puede llegar de QuickBooks como Update, por eso la tratamos
  // como nueva cuando su CreateTime pertenece a esta activación.
  const fechaCreacion = Date.parse(origen?.MetaData?.CreateTime || "");
  const integracionActivaDesde = Date.parse(QBO_INVENTORY_POLL_START_AT);
  const facturaNuevaEnEstaActivacion =
    Number.isFinite(fechaCreacion) &&
    Number.isFinite(integracionActivaDesde) &&
    fechaCreacion >= integracionActivaDesde - 60 * 1000;
  if (
    !anterior &&
    opciones.source === "webhook" &&
    opciones.operation === "Update" &&
    !facturaNuevaEnEstaActivacion
  ) {
    sincronizadas[id] = {
      lines: lineasNuevas,
      updatedAt: new Date().toISOString(),
      source: "webhook-baseline",
    };
    guardarSincronizacionFacturas(sincronizadas);
    return leerInventario();
  }

  // Una versión anterior podía guardar una factura como "baseline" cuando
  // QuickBooks enviaba Update. La revisión automática debe convertir esa base
  // en un descuento real una sola vez.
  let lineasAnterioresParaDiferencia = anterior?.lines || {};
  if (anterior?.source === "webhook-baseline" && ["polling", "reconciliation"].includes(opciones.source)) {
    lineasAnterioresParaDiferencia = {};
  }
  if (!anterior && opciones.restaurar) {
    lineasAnterioresParaDiferencia = lineasDelOrigen;
  }
  const inventario = aplicarDiferenciaInventario(
    lineasNuevas,
    lineasAnterioresParaDiferencia,
    { invoiceId: id, source: opciones.source, operation: opciones.operation }
  );
  if (!Object.keys(lineasNuevas).length) {
    console.log("QBO INVENTARIO: la factura no contiene líneas de producto:", id);
  }
  sincronizadas[id] = {
    lines: lineasNuevas,
    updatedAt: new Date().toISOString(),
    source: opciones.source || "app",
  };
  guardarSincronizacionFacturas(sincronizadas);
  return inventario;
}

// Evita que dos notificaciones iguales de QuickBooks descuenten dos veces
// mientras llegan al mismo tiempo.
const invoiceSyncLocks = new Map();
async function sincronizarFacturaInventarioSeguro(invoiceId, origen, opciones = {}) {
  const id = String(invoiceId || "").trim();
  const anterior = invoiceSyncLocks.get(id) || Promise.resolve();
  const tarea = anterior
    .catch(() => {})
    .then(() => sincronizarFacturaInventario(id, origen, opciones));
  invoiceSyncLocks.set(id, tarea);
  try {
    return await tarea;
  } finally {
    if (invoiceSyncLocks.get(id) === tarea) invoiceSyncLocks.delete(id);
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, PERSISTENT_IMAGES_DIR);
  },
  filename: (req, file, cb) => {
    const nombre = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, nombre);
  }
});

const upload = multer({ storage });
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;
// El token debe vivir en el volumen de Railway para sobrevivir despliegues y reinicios.
const TOKEN_FILE = path.join(PERSISTENT_DATA_DIR, "qbo-token.json");
const ORDERS_FILE = path.join(PERSISTENT_DATA_DIR, "orders.json");
const BARCODES_FILE = "barcodes.json";

const REDIRECT_URI =
  process.env.REDIRECT_URI || "http://localhost:3000/callback";

app.use(cors());
app.use(express.json({
  limit: "20mb",
  verify: (req, res, buffer) => {
    if (req.path === "/webhooks/quickbooks") req.rawBody = Buffer.from(buffer);
  },
}));
app.use("/images/productos", express.static(PERSISTENT_IMAGES_DIR));
app.use(express.static(__dirname));

const AUTH_COOKIE = "landp_auth";
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const AUTH_SECRET = process.env.AUTH_SECRET || "";

function contrasenaRol(rol) {
  return {
    empleado: process.env.EMPLOYEE_PASSWORD || "",
    cliente: process.env.CLIENT_PASSWORD || "",
    jefe: process.env.ADMIN_PASSWORD || process.env.DEVELOPER_PASSWORD || "",
  }[rol] || "";
}

function compararSecreto(entrada, esperado) {
  if (!entrada || !esperado) return false;
  const a = Buffer.from(String(entrada));
  const b = Buffer.from(String(esperado));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function firmaSesion(valor) {
  return crypto.createHmac("sha256", AUTH_SECRET).update(valor).digest("base64url");
}

function crearSesion(rol) {
  const payload = Buffer.from(
    JSON.stringify({ rol, exp: Date.now() + SESSION_DURATION_MS })
  ).toString("base64url");
  return `${payload}.${firmaSesion(payload)}`;
}

function cookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((resultado, parte) => {
    const separador = parte.indexOf("=");
    if (separador < 0) return resultado;
    resultado[parte.slice(0, separador).trim()] = decodeURIComponent(
      parte.slice(separador + 1).trim()
    );
    return resultado;
  }, {});
}

function leerSesion(req) {
  if (!AUTH_SECRET) return null;
  const token = cookies(req)[AUTH_COOKIE];
  if (!token) return null;
  const [payload, firma] = token.split(".");
  if (!payload || !firma || firma !== firmaSesion(payload)) return null;

  try {
    const sesion = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!sesion.rol || !contrasenaRol(sesion.rol) || Number(sesion.exp) < Date.now()) {
      return null;
    }
    return sesion;
  } catch {
    return null;
  }
}

function requiereSesion(req, res, next) {
  const sesion = leerSesion(req);
  if (!sesion) {
    return res.status(401).json({ error: "Inicia sesión para continuar" });
  }
  req.sesion = sesion;
  next();
}

function requiereRol(...roles) {
  return (req, res, next) => {
    if (!req.sesion) {
      const sesion = leerSesion(req);
      if (sesion) req.sesion = sesion;
    }
    if (!req.sesion || !roles.includes(req.sesion.rol)) {
      return res.status(403).json({ error: "No tienes permiso para esta función" });
    }
    next();
  };
}

function cookieSesion(res, valor, maxAge) {
  const seguro = REDIRECT_URI.startsWith("https://") || process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${encodeURIComponent(valor)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${seguro ? "; Secure" : ""}`
  );
}

app.post("/login", (req, res) => {
  const rol = String(req.body?.rol || "").trim().toLowerCase();
  const contrasena = String(req.body?.contrasena || "");

  if (!AUTH_SECRET || !contrasenaRol(rol)) {
    return res.status(503).json({ error: "Faltan configurar las contraseñas en Railway" });
  }

  if (!compararSecreto(contrasena, contrasenaRol(rol))) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }

  cookieSesion(res, crearSesion(rol), Math.floor(SESSION_DURATION_MS / 1000));
  res.json({ ok: true, rol });
});

app.get("/session", (req, res) => {
  const sesion = leerSesion(req);
  res.json(sesion ? { autenticado: true, rol: sesion.rol } : { autenticado: false });
});

app.post("/logout", (req, res) => {
  cookieSesion(res, "", 0);
  res.json({ ok: true });
});

const RUTAS_PROTEGIDAS = [
  "/api/imagenes-productos",
  "/api/imagenes-disponibles",
  "/api/categorias-productos",
  "/api/subfiltros-productos",
  "/api/inventario",
  "/api/productos",
  "/clientes",
  "/productos",
  "/buscar-cliente",
  "/buscar-producto",
  "/cliente",
  "/orders",
  "/crear-factura",
  "/enviar-factura-email",
  "/barcodes",
  "/barcode",
  "/buscar-por-barcode",
  "/voice-command",
  "/voice-transcribe",
  "/catalogo-local",
];

app.use((req, res, next) => {
  const protegida = RUTAS_PROTEGIDAS.some(
    (ruta) => req.path === ruta || req.path.startsWith(`${ruta}/`)
  );
  return protegida ? requiereSesion(req, res, next) : next();
});

app.get("/api/inventario", requiereRol("jefe", "empleado"), async (req, res) => {
  // Abrir la ventana del jefe hace una revisión inmediata; las actualizaciones
  // de fondo no bloquean la pantalla y siguen corriendo cada 30 segundos.
  if (req.sesion?.rol === "jefe") {
    if (String(req.query?.sync || "") === "1") {
      await sincronizarFacturasQboRecientes({ reconciliar: true });
    } else {
      void sincronizarFacturasQboRecientes();
    }
  }
  res.json({ inventario: leerInventario() });
});

app.post("/api/inventario", requiereRol("jefe"), (req, res) => {
  try {
    const lista = Array.isArray(req.body?.productos) ? req.body.productos : [];
    const inventario = leerInventario();
    for (const producto of lista) {
      const itemId = String(producto?.itemId || producto?.id || "").trim();
      const cantidad = Number(producto?.cantidad);
      if (!itemId || !Number.isFinite(cantidad) || cantidad < 0) {
        return res.status(400).json({ error: "Producto o cantidad no válida" });
      }
      inventario[itemId] = { itemId, cantidad: Math.floor(cantidad), updatedAt: new Date().toISOString() };
    }
    guardarInventario(inventario);
    res.json({ ok: true, inventario });
  } catch (error) {
    res.status(500).json({ error: "No se pudo guardar el inventario", detalle: error.message });
  }
});

app.get("/api/imagenes-productos", (req, res) => {
  res.json(leerMapaImagenes());
});
app.get("/api/categorias-productos", (req, res) => {
  res.json(leerMapaCategorias());
});
app.get("/api/subfiltros-productos", (req, res) => {
  res.json(leerMapaSubfiltros());
});
app.post("/api/productos/:id/categoria", requiereRol("jefe", "empleado"), (req, res) => {
  const id = String(req.params.id || "").trim();
  const categoria = String(req.body?.categoria || "").trim();

  if (!id) return res.status(400).json({ error: "Falta el ID del producto" });
  if (!categoria || categoria.length > 80) {
    return res.status(400).json({ error: "Selecciona una categoría válida" });
  }

  const mapa = leerMapaCategorias();
  mapa[id] = categoria;
  guardarMapaCategorias(mapa);
  res.json({ ok: true, id, categoria });
});
app.post("/api/productos/:id/subfiltro", requiereRol("jefe", "empleado"), (req, res) => {
  const id = String(req.params.id || "").trim();
  const subfiltro = String(req.body?.subfiltro || "").trim();
  if (!id) return res.status(400).json({ error: "Falta el ID del producto" });
  if (!["", "Barcel", "Chicas", "Salsas"].includes(subfiltro)) {
    return res.status(400).json({ error: "Subfiltro no válido" });
  }
  const mapa = leerMapaSubfiltros();
  if (subfiltro) mapa[id] = subfiltro;
  else delete mapa[id];
  guardarMapaSubfiltros(mapa);
  res.json({ ok: true, id, subfiltro });
});
app.get("/api/imagenes-disponibles", (req, res) => {
  try {
    const imagenes = [
      ...new Set(
        [REPO_IMAGES_DIR, PERSISTENT_IMAGES_DIR].flatMap(carpeta =>
          fs.existsSync(carpeta)
            ? fs
                .readdirSync(carpeta)
                .filter(nombre => /\.(jpg|jpeg|png|webp|gif)$/i.test(nombre))
            : []
        )
      )
    ].sort();

    res.json(imagenes);
  } catch (error) {
    console.error("Error leyendo imágenes:", error);
    res.status(500).json({ error: "No se pudieron leer las imágenes" });
  }
});
app.post("/api/productos/:id/imagen", requiereRol("empleado", "jefe"), upload.single("imagen"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ninguna imagen" });
    }

    const id = String(req.params.id);
    const rutaImagen = `/images/productos/${req.file.filename}`;

    const archivoCatalogo = path.join(__dirname, "catalogo_maestro_sistema.json");
    const catalogo = JSON.parse(fs.readFileSync(archivoCatalogo, "utf8"));

const producto = catalogo.productos.find(p => {
  const principal = String(p.productoQuickBooksPrincipal || "");
  const equivalentes = p.productosQuickBooksEquivalentes || [];

  return (
    String(p.Id || p.id || "") === id ||
    principal === id ||
    equivalentes.map(String).includes(id)
  );
});

    if (!producto) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const claveProducto =
      String(producto.productoQuickBooksPrincipal || "").trim() || id;
    const mapaImagenes = leerMapaImagenes();
    const rutaAnterior = mapaImagenes[claveProducto];

    mapaImagenes[claveProducto] = rutaImagen;
    guardarMapaImagenes(mapaImagenes);

    if (rutaAnterior && rutaAnterior !== rutaImagen) {
      const archivoAnterior = path.join(
        PERSISTENT_IMAGES_DIR,
        path.basename(rutaAnterior)
      );
      if (fs.existsSync(archivoAnterior)) {
        fs.unlink(archivoAnterior, () => {});
      }
    }

    res.json({
      ok: true,
      imagen: rutaImagen
    });
  } catch (error) {
    console.error("Error guardando imagen:", error);
    res.status(500).json({ error: "No se pudo guardar la imagen" });
  }
});
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.get("/images/default.png", (req, res) => {
  res.sendFile(path.join(__dirname, "images", "logo-nuevo.jpg"));
});

const oauthClient = new OAuthClient({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  environment: process.env.QBO_ENVIRONMENT || "sandbox",
  redirectUri: REDIRECT_URI,
});

function guardarToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

function leerToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error("Primero conecta QuickBooks en /connect-qbo");
  }

  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

let tokenRefreshEnCurso = null;

async function obtenerTokenValido() {
  if (tokenRefreshEnCurso) return tokenRefreshEnCurso;

  tokenRefreshEnCurso = (async () => {
    const token = leerToken();
    oauthClient.setToken(token);

    try {
      const nuevo = await oauthClient.refreshUsingToken(token.refresh_token);
      const nuevoToken = nuevo.getJson();

      nuevoToken.realmId = token.realmId;

      guardarToken(nuevoToken);
      return nuevoToken;
    } catch (error) {
      console.log("NO SE PUDO REFRESCAR TOKEN:");
      console.log(
        JSON.stringify(error.response?.data || error.message || error, null, 2)
      );

      throw new Error("QuickBooks necesita volver a conectarse en /connect-qbo");
    } finally {
      tokenRefreshEnCurso = null;
    }
  })();

  return tokenRefreshEnCurso;
}

function qboBaseUrl(token) {
  return `https://quickbooks.api.intuit.com/v3/company/${token.realmId}`;
}

async function qboGet(pathUrl) {
  const token = await obtenerTokenValido();
  const url = `${qboBaseUrl(token)}${pathUrl}`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json",
    },
  });

  return response.data;
}

function leerEstadoRevisionQbo() {
  try {
    if (!fs.existsSync(QBO_INVENTORY_POLL_FILE)) {
      const inicial = {
        lastSeenAt: QBO_INVENTORY_POLL_START_AT,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(QBO_INVENTORY_POLL_FILE, JSON.stringify(inicial, null, 2), "utf8");
      return inicial;
    }
    const estado = JSON.parse(fs.readFileSync(QBO_INVENTORY_POLL_FILE, "utf8"));
    if (!estado || !estado.lastSeenAt || !Number.isFinite(Date.parse(estado.lastSeenAt))) {
      throw new Error("Estado de sincronización inválido");
    }
    return estado;
  } catch (error) {
    console.error("QBO INVENTARIO: no se pudo leer el estado de revisión:", error.message || error);
    const inicial = { lastSeenAt: QBO_INVENTORY_POLL_START_AT, createdAt: new Date().toISOString() };
    fs.writeFileSync(QBO_INVENTORY_POLL_FILE, JSON.stringify(inicial, null, 2), "utf8");
    return inicial;
  }
}

function guardarEstadoRevisionQbo(estado) {
  fs.writeFileSync(QBO_INVENTORY_POLL_FILE, JSON.stringify(estado, null, 2), "utf8");
}

function fechaConsultaQbo(valor) {
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return fecha.toISOString().replace(/\.\d{3}Z$/, "Z");
}

let qboInventarioRevisionEnCurso = null;

async function reconciliarFacturasRegistradas() {
  const sincronizadas = leerSincronizacionFacturas();
  let revisadas = 0;
  let restauradas = 0;

  for (const [invoiceId, registro] of Object.entries(sincronizadas)) {
    if (!registro || !Object.keys(registro.lines || {}).length) continue;
    revisadas += 1;
    try {
      const data = await qboGet("/invoice/" + encodeURIComponent(invoiceId) + "?minorversion=75");
      const factura = data?.Invoice;
      if (!factura) continue;
      const anulada = facturaEstaAnulada(factura);
      await sincronizarFacturaInventarioSeguro(invoiceId, factura, {
        source: "reconciliation",
        operation: anulada ? "Void" : "Update",
        restaurar: anulada,
      });
      if (anulada) {
        restauradas += 1;
        console.log("QBO INVENTARIO: factura anulada detectada al reconciliar, inventario restaurado:", invoiceId);
      }
    } catch (error) {
      if (!facturaNoEncontradaQbo(error)) {
        console.error("QBO INVENTARIO: no se pudo reconciliar factura:", invoiceId, error.response?.data || error.message || error);
        continue;
      }
      await sincronizarFacturaInventarioSeguro(invoiceId, [], {
        source: "reconciliation",
        operation: "Delete",
        restaurar: true,
      });
      restauradas += 1;
      console.log("QBO INVENTARIO: factura eliminada detectada al reconciliar, inventario restaurado:", invoiceId);
    }
  }

  return { revisadas, restauradas };
}

async function sincronizarFacturasQboRecientes(opciones = {}) {
  if (qboInventarioRevisionEnCurso) {
    const resultadoActual = await qboInventarioRevisionEnCurso;
    return opciones.reconciliar
      ? sincronizarFacturasQboRecientes(opciones)
      : resultadoActual;
  }

  qboInventarioRevisionEnCurso = (async () => {
    const estado = leerEstadoRevisionQbo();
    const ultima = Date.parse(estado.lastSeenAt);
    // Dejamos cinco segundos de traslape para no perder facturas que compartan
    // exactamente la misma hora. El archivo de sincronización evita duplicados.
    const desde = new Date(Math.max(0, ultima - 5000));
    const query = encodeURIComponent(
      `SELECT * FROM Invoice WHERE MetaData.LastUpdatedTime >= '${fechaConsultaQbo(desde)}' MAXRESULTS 1000`
    );
    const data = await qboGet(`/query?query=${query}&minorversion=75`);
    const facturas = Array.isArray(data?.QueryResponse?.Invoice)
      ? data.QueryResponse.Invoice
      : [];
    let mayorFecha = ultima;

    for (const factura of facturas) {
      const invoiceId = String(factura?.Id || "").trim();
      if (!invoiceId) continue;
      const actualizada = Date.parse(factura?.MetaData?.LastUpdatedTime || "");
      if (Number.isFinite(actualizada)) mayorFecha = Math.max(mayorFecha, actualizada);
      const anulada = facturaEstaAnulada(factura);
      await sincronizarFacturaInventarioSeguro(invoiceId, factura, {
        source: "polling",
        operation: anulada ? "Void" : "Create",
        restaurar: anulada,
      });
    }

    const reconciliacion = opciones.reconciliar
      ? await reconciliarFacturasRegistradas()
      : { revisadas: 0, restauradas: 0 };

    if (mayorFecha > ultima) {
      guardarEstadoRevisionQbo({
        ...estado,
        lastSeenAt: new Date(mayorFecha).toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    if (facturas.length || reconciliacion.revisadas || reconciliacion.restauradas) {
      console.log(
        "QBO INVENTARIO: revisión automática terminada:",
        facturas.length,
        "factura(s); reconciliadas:",
        reconciliacion.revisadas,
        "; restauradas:",
        reconciliacion.restauradas
      );
    }
    return facturas.length;
  })()
    .catch((error) => {
      console.error(
        "QBO INVENTARIO: error en revisión automática:",
        error.response?.data || error.message || error
      );
      return 0;
    })
    .finally(() => {
      qboInventarioRevisionEnCurso = null;
    });

  return qboInventarioRevisionEnCurso;
}

let productosRefreshEnCurso = null;

function leerCacheProductos() {
  try {
    if (!fs.existsSync(PRODUCTS_CACHE_FILE)) return null;
    const cache = JSON.parse(fs.readFileSync(PRODUCTS_CACHE_FILE, "utf8"));
    return cache && cache.data ? cache : null;
  } catch (error) {
    console.error("Error leyendo caché de productos:", error);
    return null;
  }
}

function guardarCacheProductos(data) {
  fs.writeFileSync(
    PRODUCTS_CACHE_FILE,
    JSON.stringify({ updatedAt: Date.now(), data }, null, 2),
    "utf8"
  );
}

function actualizarCacheProductos() {
  if (productosRefreshEnCurso) return productosRefreshEnCurso;
  const query = encodeURIComponent("SELECT * FROM Item MAXRESULTS 1000");
  productosRefreshEnCurso = qboGet(`/query?query=${query}&minorversion=75`)
    .then((data) => {
      guardarCacheProductos(data);
      return data;
    })
    .catch((error) => {
      console.error("No se pudo actualizar el catálogo desde QuickBooks:", error.response?.data || error.message || error);
      return null;
    })
    .finally(() => {
      productosRefreshEnCurso = null;
    });
  return productosRefreshEnCurso;
}

async function qboGetBinary(pathUrl) {
  const token = await obtenerTokenValido();
  const url = `${qboBaseUrl(token)}${pathUrl}`;

  const response = await axios.get(url, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/pdf",
    },
  });

  return Buffer.from(response.data);
}

async function qboPost(pathUrl, body) {
  const token = await obtenerTokenValido();
  const url = `${qboBaseUrl(token)}${pathUrl}`;

  const response = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  return response.data;
}

function leerJsonArchivo(nombreArchivo, valorInicial) {
  if (!fs.existsSync(nombreArchivo)) {
    fs.writeFileSync(nombreArchivo, JSON.stringify(valorInicial, null, 2));
  }

  return JSON.parse(fs.readFileSync(nombreArchivo, "utf8"));
}

function guardarJsonArchivo(nombreArchivo, data) {
  fs.writeFileSync(nombreArchivo, JSON.stringify(data, null, 2));
}

function leerOrdenes() {
  const legacyFile = path.join(__dirname, "orders.json");
  if (!fs.existsSync(ORDERS_FILE) && fs.existsSync(legacyFile) && legacyFile !== ORDERS_FILE) {
    try {
      fs.copyFileSync(legacyFile, ORDERS_FILE);
    } catch (error) {
      console.error("No se pudo migrar el archivo anterior de pedidos:", error);
    }
  }
  return leerJsonArchivo(ORDERS_FILE, []);
}

function guardarOrdenes(orders) {
  guardarJsonArchivo(ORDERS_FILE, orders);
}

function leerBarcodes() {
  return leerJsonArchivo(BARCODES_FILE, []);
}

function guardarBarcodes(data) {
  guardarJsonArchivo(BARCODES_FILE, data);
}

function limpiarTexto(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// Los códigos del catálogo pueden llevar espacios, diagonales o prefijos de
// QuickBooks. Se comparan también en formato compacto para que el lector no
// dependa de que el texto coincida carácter por carácter.
function claveProductoBarcode(texto) {
  return limpiarTexto(sinPrefijoQuickBooks(texto)).replace(/[^a-z0-9]/g, "");
}

function normalizarBarcode(texto) {
  // Conservamos ceros iniciales: forman parte del EAN/UPC.
  return String(texto || "").replace(/[\r\n\s]/g, "").trim();
}

function productoCachePorClave(clave, items) {
  const objetivo = claveProductoBarcode(clave);
  if (!objetivo) return null;
  return (items || []).find((item) => {
    const valores = [item.Name, item.FullyQualifiedName, item.Sku, item.Description]
      .filter(Boolean)
      .map(claveProductoBarcode)
      .filter(Boolean);
    return valores.some((valor) => valor === objetivo || valor.endsWith(objetivo));
  }) || null;
}

function sinPrefijoQuickBooks(valor) {
  const texto = String(valor || "").trim();
  const separador = texto.lastIndexOf(":");
  return (separador >= 0 ? texto.slice(separador + 1) : texto).trim();
}

function obtenerEmailCliente(customer) {
  return (
    customer?.PrimaryEmailAddr?.Address ||
    customer?.PrimaryEmailAddr?.address ||
    ""
  );
}

function crearTransporterCorreo() {
  if (
    !process.env.SMTP_HOST ||
    !process.env.SMTP_USER ||
    !process.env.SMTP_PASS
  ) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_PORT) === "465",
    // Railway puede resolver smtp.gmail.com a IPv6, pero su contenedor
    // no siempre tiene salida IPv6. Forzamos IPv4 para evitar ENETUNREACH.
    family: 4,
    connectionTimeout: 20000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function formatoDinero(numero) {
  return Number(numero || 0).toFixed(2);
}

function crearHtmlFactura({ clienteNombre, invoice, items }) {
  const docNumber = invoice?.DocNumber || invoice?.Id || "Sin número";
  const total = invoice?.TotalAmt || items.reduce((s, p) => {
    return s + Number(p.unitPrice || p.price || 0) * Number(p.qty || p.quantity || 1);
  }, 0);

  const filas = items.map((item) => {
    const nombre = sinPrefijoQuickBooks(
      item.name || item.nombre || item.description || item.descripcion || item.itemName || "Producto"
    );
    const qty = Number(item.qty || item.quantity || 1);
    const precio = Number(item.unitPrice || item.price || 0);
    const subtotal = qty * precio;

    return `
      <tr>
        <td>${nombre}</td>
        <td style="text-align:center;">${qty}</td>
        <td style="text-align:right;">$${formatoDinero(precio)}</td>
        <td style="text-align:right;">$${formatoDinero(subtotal)}</td>
      </tr>
    `;
  }).join("");

  return `
    <div style="font-family:Arial,sans-serif;color:#111827;">
      <h2>Distribuidora L&P</h2>
      <p><strong>Folio / Invoice no.:</strong> ${docNumber}</p>
      <p><strong>ID de QuickBooks:</strong> ${invoice?.Id || "No disponible"}</p>
      <p><strong>Estado:</strong> Factura creada correctamente en QuickBooks.</p>
      <p><strong>Cliente:</strong> ${clienteNombre}</p>

      <table style="width:100%;border-collapse:collapse;margin-top:15px;">
        <thead>
          <tr>
            <th style="border-bottom:1px solid #ddd;text-align:left;">Producto</th>
            <th style="border-bottom:1px solid #ddd;">Cantidad</th>
            <th style="border-bottom:1px solid #ddd;text-align:right;">Precio</th>
            <th style="border-bottom:1px solid #ddd;text-align:right;">Subtotal</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>

      <h2 style="text-align:right;">Total: $${formatoDinero(total)}</h2>
      <p>Gracias por su compra.</p>
    </div>
  `;
}

function crearHtmlPedidoPendiente({ clienteNombre, orderId, items }) {
  const filas = (Array.isArray(items) ? items : []).map((item) => {
    const nombre = sinPrefijoQuickBooks(
      item.name || item.nombre || item.qboNombre || item.description || "Producto"
    );
    const qty = Number(item.qty || item.quantity || item.cantidad || 1);
    const precio = Number(item.unitPrice || item.price || item.precio || 0);
    return `<tr><td>${nombre}</td><td style="text-align:center;">${qty}</td><td style="text-align:right;">$${formatoDinero(precio * qty)}</td></tr>`;
  }).join("");
  const total = (Array.isArray(items) ? items : []).reduce(
    (s, item) => s + Number(item.unitPrice || item.price || item.precio || 0) * Number(item.qty || item.quantity || item.cantidad || 1),
    0
  );
  return `<div style="font-family:Arial,sans-serif;color:#111827;"><h2>Pedido pendiente de autorización</h2><p><strong>Pedido:</strong> ${orderId}</p><p><strong>Cliente:</strong> ${clienteNombre || "Cliente"}</p><table style="width:100%;border-collapse:collapse;margin-top:15px;"><thead><tr><th style="border-bottom:1px solid #ddd;text-align:left;">Producto</th><th style="border-bottom:1px solid #ddd;">Cantidad</th><th style="border-bottom:1px solid #ddd;text-align:right;">Subtotal</th></tr></thead><tbody>${filas}</tbody></table><h2 style="text-align:right;">Total: $${formatoDinero(total)}</h2><p>Revísalo en la aplicación para aprobarlo y crear la factura en QuickBooks.</p></div>`;
}

async function enviarPedidoPendientePorCorreo({ clienteEmail, clienteNombre, bossEmail, orderId, items }) {
  const transporter = crearTransporterCorreo();
  if (!transporter) return { enviado: false, motivo: "SMTP no configurado" };
  const destinatarios = [clienteEmail, bossEmail].filter(Boolean);
  if (!destinatarios.length) return { enviado: false, motivo: "No hay correos destino" };
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: destinatarios.join(","),
    subject: `Pedido pendiente de autorización #${orderId}`,
    html: crearHtmlPedidoPendiente({ clienteNombre, orderId, items }),
  });
  return { enviado: true, destinatarios };
}

async function enviarPedidoRechazadoPorCorreo({ clienteEmail, clienteNombre, bossEmail, orderId, items }) {
  const transporter = crearTransporterCorreo();
  if (!transporter) return { enviado: false, motivo: "SMTP no configurado" };
  const destinatarios = [clienteEmail, bossEmail].filter(Boolean);
  if (!destinatarios.length) return { enviado: false, motivo: "No hay correos destino" };
  const html = crearHtmlPedidoPendiente({ clienteNombre, orderId, items })
    .replace("Pedido pendiente de autorización", "Pedido rechazado")
    .replace("Revísalo en la aplicación para aprobarlo y crear la factura en QuickBooks.", "Este pedido fue rechazado y no se envió a QuickBooks.");
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: destinatarios.join(","),
    subject: `Pedido rechazado #${orderId}`,
    html,
  });
  return { enviado: true, destinatarios };
}

async function enviarFacturaPorCorreo({
  clienteEmail,
  clienteNombre,
  bossEmail,
  invoice,
  items,
}) {
  const transporter = crearTransporterCorreo();

  if (!transporter) {
    console.log("CORREO NO CONFIGURADO. Falta SMTP en .env");
    return { enviado: false, motivo: "SMTP no configurado" };
  }

  const invoiceId = invoice?.Id;
  const docNumber = invoice?.DocNumber || invoiceId || "factura";
  const html = crearHtmlFactura({ clienteNombre, invoice, items });

  let attachments = [];

  try {
    if (invoiceId) {
      const pdf = await qboGetBinary(`/invoice/${invoiceId}/pdf?minorversion=75`);
      attachments.push({
        filename: `factura-${docNumber}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      });
    }
  } catch (error) {
    console.log("NO SE PUDO DESCARGAR PDF DE QUICKBOOKS:");
    console.log(error.response?.data || error.message || error);
  }

  const destinatarios = [];

  if (clienteEmail) destinatarios.push(clienteEmail);
  if (bossEmail) destinatarios.push(bossEmail);

  if (destinatarios.length === 0) {
    return { enviado: false, motivo: "No hay correos destino" };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: destinatarios.join(","),
    subject: `Factura creada en QuickBooks - Distribuidora L&P #${docNumber}`,
    html,
    attachments,
  });

  return { enviado: true, destinatarios };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/catalogo-local", (req, res) => {
  try {
    const archivo = path.join(__dirname, "catalogo_maestro_sistema.json");
    const catalogo = JSON.parse(fs.readFileSync(archivo, "utf8"));
    res.json(catalogo);
  } catch (error) {
    res.status(500).json({
      error: "No se pudo cargar el catálogo local",
      detalle: error.message,
    });
  }
});
app.get("/connect-qbo", requiereRol("jefe"), (req, res) => {
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: "LandPReal",
  });

  console.log("AUTH URL:");
  console.log(authUri);

  res.redirect(authUri);
});app.get("/callback", async (req, res) => {
  try {
    console.log("CALLBACK RECIBIDO:");
    console.log(req.url);

    const authResponse = await oauthClient.createToken(req.url);
    const token = authResponse.getJson();

    token.realmId = req.query.realmId;

    guardarToken(token);

    console.log("TOKEN GUARDADO:", TOKEN_FILE);
    console.log("REALM ID:", token.realmId);

    res.send(`
      <h2>QuickBooks conectado correctamente</h2>
      <p>Ya puedes cerrar esta ventana y regresar a la aplicación.</p>
      <a href="/">Volver a la app</a>
    `);
  } catch (error) {
    console.log("ERROR OAUTH:");
    console.log(
      JSON.stringify(error.response?.data || error.message || error, null, 2)
    );

    res.status(500).send(`
      <h2>Error conectando QuickBooks</h2>
      <p>Vuelve a intentar desde /connect-qbo</p>
    `);
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "Distribuidora L&P",
    port: PORT,
    redirect: REDIRECT_URI,
    qboEnvironment: process.env.QBO_ENVIRONMENT || "sandbox",
    emailConfigured: !!crearTransporterCorreo(),
  });
});

app.get("/clientes", async (req, res) => {
  try {
    const query = encodeURIComponent("SELECT * FROM Customer MAXRESULTS 1000");
    const data = await qboGet(`/query?query=${query}&minorversion=75`);
    res.json(data);
  } catch (error) {
    console.log("ERROR CLIENTES:");
    console.log(
      JSON.stringify(error.response?.data || error.message || error, null, 2)
    );

    res.status(500).json({
      error: "Error obteniendo clientes",
      detalle: error.response?.data || error.message || String(error.message || error),
    });
  }
});

app.get("/productos", async (req, res) => {
  try {
    const cache = leerCacheProductos();
    if (cache?.data) {
      res.setHeader("X-Catalog-Updated", new Date(Number(cache.updatedAt || 0)).toISOString());
      res.json(cache.data);
      if (Date.now() - Number(cache.updatedAt || 0) >= PRODUCTS_CACHE_TTL_MS) {
        void actualizarCacheProductos();
      }
      return;
    }

    const data = await actualizarCacheProductos();
    if (!data) {
      return res.status(503).json({
        error: "El catálogo todavía no está disponible",
        detalle: "QuickBooks no respondió y aún no existe una copia local del catálogo",
      });
    }
    res.json(data);
  } catch (error) {
    console.log("ERROR PRODUCTOS:");
    console.log(
      JSON.stringify(error.response?.data || error.message || error, null, 2)
    );

    res.status(500).json({
      error: "Error obteniendo productos",
      detalle: error.response?.data || error.message || String(error.message || error),
    });
  }
});

app.get("/buscar-cliente", async (req, res) => {
  try {
    const texto = limpiarTexto(req.query.q || "");

    if (!texto) {
      return res.status(400).json({ error: "Falta búsqueda del cliente" });
    }

    const query = encodeURIComponent("SELECT * FROM Customer MAXRESULTS 1000");
    const data = await qboGet(`/query?query=${query}&minorversion=75`);
    const clientes = data.QueryResponse?.Customer || [];

    const encontrados = clientes
      .map((cliente) => {
        const nombre = limpiarTexto(
          cliente.DisplayName || cliente.FullyQualifiedName || cliente.CompanyName || ""
        );

        let score = 0;

        if (nombre === texto) score = 100;
        else if (nombre.includes(texto)) score = 80;
        else {
          const partes = texto.split(/\s+/).filter(Boolean);
          const coincidencias = partes.filter((p) => nombre.includes(p)).length;
          score = coincidencias * 20;
        }

        return { cliente, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((r) => r.cliente);

    res.json({
      query: req.query.q,
      count: encontrados.length,
      clientes: encontrados,
    });
  } catch (error) {
    console.log("ERROR BUSCANDO CLIENTE:");
    console.log(error.response?.data || error.message || error);

    res.status(500).json({
      error: "Error buscando cliente",
      detalle: error.response?.data || error.message || String(error),
    });
  }
});

app.get("/buscar-producto", async (req, res) => {
  try {
    const texto = limpiarTexto(req.query.q || "");

    if (!texto) {
      return res.status(400).json({ error: "Falta búsqueda del producto" });
    }

    const query = encodeURIComponent("SELECT * FROM Item MAXRESULTS 1000");
    const data = await qboGet(`/query?query=${query}&minorversion=75`);
    const productos = data.QueryResponse?.Item || [];

    const encontrados = productos
      .map((producto) => {
        const nombre = limpiarTexto(
          producto.Name || producto.FullyQualifiedName || producto.Description || ""
        );
        const sku = limpiarTexto(producto.Sku || producto.SKU || "");

        let score = 0;

        if (nombre === texto || sku === texto) score = 100;
        else if (nombre.includes(texto) || sku.includes(texto)) score = 80;
        else {
          const partes = texto.split(/\s+/).filter(Boolean);
          const coincidencias = partes.filter((p) => {
            return nombre.includes(p) || sku.includes(p);
          }).length;

          score = coincidencias * 20;
        }

        return { producto, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((r) => r.producto);

    res.json({
      query: req.query.q,
      count: encontrados.length,
      productos: encontrados,
    });
  } catch (error) {
    console.log("ERROR BUSCANDO PRODUCTO:");
    console.log(error.response?.data || error.message || error);

    res.status(500).json({
      error: "Error buscando producto",
      detalle: error.response?.data || error.message || String(error),
    });
  }
});

app.get("/cliente/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) {
      return res.status(400).json({ error: "Falta ID del cliente" });
    }

    const query = encodeURIComponent(`SELECT * FROM Customer WHERE Id = '${id}'`);
    const data = await qboGet(`/query?query=${query}&minorversion=75`);
    const cliente = data.QueryResponse?.Customer?.[0] || null;

    if (!cliente) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json(cliente);
  } catch (error) {
    console.log("ERROR OBTENIENDO CLIENTE:");
    console.log(error.response?.data || error.message || error);

    res.status(500).json({
      error: "Error obteniendo cliente",
      detalle: error.response?.data || error.message || String(error),
    });
  }
});

app.get("/orders", (req, res) => {
  try {
    // Solo los pedidos creados con el flujo actual pueden aprobarse.
    // Los registros antiguos no tienen customerId/status y no deben aparecer
    // como pendientes ni provocar el error "Falta customerId".
    res.json(leerOrdenes().filter((order) => String(order?.status || "") === "pending"));
  } catch (error) {
    res.status(500).json({
      error: "Error leyendo órdenes",
      detalle: error.message || String(error),
    });
  }
});

app.post("/orders", async (req, res) => {
  try {
    const orders = leerOrdenes();

    const newOrder = {
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      customerId: req.body.customerId || req.body.customer?.id || null,
      customerName: req.body.customerName || req.body.customer?.name || null,
      customerEmail: req.body.customerEmail || req.body.customer?.email || "",
      customer: req.body.customer || null,
      items: req.body.items || [],
      status: "pending",
    };

    orders.push(newOrder);
    guardarOrdenes(orders);

    let email = null;
    try {
      email = await enviarPedidoPendientePorCorreo({
        clienteEmail: newOrder.customerEmail,
        clienteNombre: newOrder.customerName,
        bossEmail: process.env.BOSS_EMAIL || process.env.JEFE_EMAIL || "",
        orderId: newOrder.id,
        items: newOrder.items,
      });
    } catch (emailError) {
      console.error("Error enviando aviso de pedido pendiente:", emailError);
      email = { enviado: false, motivo: emailError.message || "No se pudo enviar el aviso" };
    }

    res.json({ ...newOrder, email });
  } catch (error) {
    res.status(500).json({
      error: "Error guardando orden",
      detalle: error.message || String(error),
    });
  }
});
app.post("/orders/:id/status", requiereRol("empleado", "jefe"), (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const status = String(req.body?.status || "").trim().toLowerCase();
    if (!id) return res.status(400).json({ error: "Falta el ID del pedido" });
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Estado de pedido no válido" });
    }

    const orders = leerOrdenes();
    const order = orders.find((item) => String(item.id) === id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado" });

    order.status = status;
    order.updatedAt = new Date().toISOString();
    if (req.body?.invoiceId) order.invoiceId = String(req.body.invoiceId);
    guardarOrdenes(orders);
    if (status === "rejected") {
      void enviarPedidoRechazadoPorCorreo({
        clienteEmail: order.customerEmail || order.customer?.email || "",
        clienteNombre: order.customerName || order.customer?.name || "Cliente",
        bossEmail: process.env.BOSS_EMAIL || process.env.JEFE_EMAIL || "",
        orderId: order.id,
        items: order.items || [],
      }).then((email) => {
        console.log("Aviso de pedido rechazado:", email);
      }).catch((emailError) => {
        console.error("Error enviando aviso de pedido rechazado:", emailError);
      });
    }
    res.json({ ...order, email: status === "rejected" ? { pendiente: true } : null });
  } catch (error) {
    res.status(500).json({
      error: "Error actualizando pedido",
      detalle: error.message || String(error),
    });
  }
});
function firmaWebhookQuickBooksValida(req) {
  if (!QBO_WEBHOOK_VERIFIER_TOKEN || !req.rawBody) return false;
  let recibida = String(req.headers["intuit-signature"] || "").trim();
  if (recibida.toLowerCase().startsWith("sha256=")) {
    recibida = recibida.slice("sha256=".length).trim();
  }
  const esperadas = [
    crypto.createHmac("sha256", QBO_WEBHOOK_VERIFIER_TOKEN).update(req.rawBody).digest("base64"),
    crypto.createHmac("sha256", QBO_WEBHOOK_VERIFIER_TOKEN).update(req.rawBody).digest("hex"),
    crypto.createHmac("sha256", QBO_WEBHOOK_VERIFIER_TOKEN).update(req.rawBody).digest("base64url"),
  ];
  return esperadas.some((esperada) => {
    const a = Buffer.from(recibida);
    const b = Buffer.from(esperada);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

function normalizarEventosWebhookQuickBooks(payload) {
  const antiguos = Array.isArray(payload?.eventNotifications)
    ? payload.eventNotifications
    : null;
  if (antiguos) return antiguos;

  const eventos = Array.isArray(payload) ? payload : [payload];
  const operaciones = {
    create: "Create",
    created: "Create",
    update: "Update",
    updated: "Update",
    delete: "Delete",
    deleted: "Delete",
    void: "Void",
    voided: "Void",
    merge: "Merge",
    merged: "Merge",
  };

  return eventos
    .map((evento) => {
      const partes = String(evento?.type || evento?.eventType || "").split(".");
      const entidadTipo = String(
        evento?.data?.name || evento?.data?.entityName || partes[1] || ""
      ).trim();
      const operacionCruda = String(
        evento?.data?.operation || operaciones[String(partes[2] || "").toLowerCase()] || ""
      ).trim();
      const operacion =
        operaciones[operacionCruda.toLowerCase()] ||
        (operacionCruda
          ? operacionCruda.charAt(0).toUpperCase() + operacionCruda.slice(1).toLowerCase()
          : "");
      const id = String(
        evento?.intuitentityid || evento?.data?.id || evento?.data?.entityId || ""
      ).trim();
      const nombre = entidadTipo
        ? entidadTipo.charAt(0).toUpperCase() + entidadTipo.slice(1)
        : "";
      return {
        realmId: evento?.intuitaccountid || evento?.realmId || evento?.data?.realmId || "",
        dataChangeEvent: {
          entities: id && nombre && operacion
            ? [{ id, name: nombre, operation: operacion }]
            : [],
        },
      };
    })
    .filter((evento) => evento.dataChangeEvent.entities.length > 0);
}

async function procesarCambiosQuickBooks(payload) {
  const notificaciones = normalizarEventosWebhookQuickBooks(payload);
  const token = leerToken();
  for (const notificacion of Array.isArray(notificaciones) ? notificaciones : []) {
    if (notificacion.realmId && token.realmId && String(notificacion.realmId) !== String(token.realmId)) continue;
    const entidades = notificacion.dataChangeEvent?.entities || [];
    for (const entidad of entidades) {
      if (String(entidad.name || "").toLowerCase() !== "invoice") continue;
      const invoiceId = String(entidad.id || "").trim();
      const operation = String(entidad.operation || "").trim();
      const operationLower = operation.toLowerCase();
      if (!invoiceId) continue;
      if (["delete", "deleted", "void", "voided"].includes(operationLower)) {
        const operationCanonica = operationLower.startsWith("delete") ? "Delete" : "Void";
        await sincronizarFacturaInventarioSeguro(invoiceId, [], {
          source: "webhook",
          operation: operationCanonica,
          restaurar: true,
        });
        console.log("QuickBooks: factura eliminada/anulada, inventario restaurado:", invoiceId);
        continue;
      }
      if (!["create", "update"].includes(operationLower)) continue;
      const data = await qboGet("/invoice/" + encodeURIComponent(invoiceId) + "?minorversion=75");
      const factura = data.Invoice || {};
      const anulada = facturaEstaAnulada(factura);
      await sincronizarFacturaInventarioSeguro(invoiceId, factura, {
        source: "webhook",
        operation: anulada ? "Void" : operationLower === "create" ? "Create" : "Update",
        restaurar: anulada,
      });
      console.log("QuickBooks: factura sincronizada con inventario:", invoiceId, anulada ? "Void" : operationLower);
    }
  }
}

app.post("/webhooks/quickbooks", (req, res) => {
  console.log("QBO WEBHOOK RECIBIDO:", JSON.stringify({
    rawBodyBytes: Buffer.isBuffer(req.rawBody) ? req.rawBody.length : 0,
    tieneFirma: Boolean(req.headers["intuit-signature"]),
    tieneToken: Boolean(QBO_WEBHOOK_VERIFIER_TOKEN),
    contentType: req.headers["content-type"] || "",
  }));
  if (!QBO_WEBHOOK_VERIFIER_TOKEN) {
    console.error("QBO WEBHOOK RECHAZADO: falta QBO_WEBHOOK_VERIFIER_TOKEN");
    return res.status(503).json({ error: "Falta QBO_WEBHOOK_VERIFIER_TOKEN en Railway" });
  }
  if (!firmaWebhookQuickBooksValida(req)) {
    console.error("QBO WEBHOOK RECHAZADO: firma inválida o cuerpo sin capturar");
    return res.status(401).json({ error: "Firma de QuickBooks no válida" });
  }
  console.log("QBO WEBHOOK ACEPTADO");
  res.status(200).json({ ok: true });
  void procesarCambiosQuickBooks(req.body).catch((error) => {
    console.error("ERROR SINCRONIZANDO FACTURA DE QUICKBOOKS:", error.response?.data || error.message || error);
  });
});

app.post("/crear-factura", requiereRol("empleado", "jefe"), async (req, res) => {
  try {
    const {
      customerId,
      customerName,
      customerEmail,
      sendEmail,
      items,
    } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: "Falta customerId" });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Faltan productos/items" });
    }

    const invoice = {
      CustomerRef: {
        value: String(customerId),
      },
      Line: items.map((item) => {
        const qty = Number(item.qty || item.quantity || item.cantidad || 1);
        const unitPrice = Number(item.unitPrice || item.price || item.precio || 0);
        const itemId = item.itemId || item.id;
        const nombre = sinPrefijoQuickBooks(
          item.quickbooksName || item.qboName || item.name || item.nombre ||
            item.description || item.descripcion || "Producto"
        );
        const descripcion = sinPrefijoQuickBooks(
          item.description || item.descripcion || nombre
        );

        if (!itemId) {
          throw new Error("Producto sin itemId");
        }

        return {
          DetailType: "SalesItemLineDetail",
          Amount: Number((qty * unitPrice).toFixed(2)),
          Description: descripcion,
          SalesItemLineDetail: {
            ItemRef: {
              value: String(itemId),
              name: nombre,
            },
            Qty: qty,
            UnitPrice: unitPrice,
          },
        };
      }),
    };

    console.log("FACTURA A ENVIAR A QUICKBOOKS:");
    console.log(JSON.stringify(invoice, null, 2));

    const data = await qboPost("/invoice?minorversion=75", invoice);
    const inventarioActualizado = await sincronizarFacturaInventarioSeguro(
      data.Invoice?.Id,
      data.Invoice || items,
      { source: "app", operation: "Create" }
    );
    let email = null;

    if (sendEmail) {
      try {
        email = await enviarFacturaPorCorreo({
          clienteEmail: customerEmail || "",
          clienteNombre: customerName || "Cliente",
          bossEmail: process.env.BOSS_EMAIL || process.env.JEFE_EMAIL || "",
          invoice: data.Invoice,
          items,
        });
      } catch (emailError) {
        console.log("ERROR ENVIANDO COPIA DE FACTURA POR CORREO:");
        console.log(emailError.response?.data || emailError.message || emailError);
        email = {
          enviado: false,
          motivo: emailError.message || "No se pudo enviar el correo",
        };
      }
    }

    res.json({
      success: true,
      invoice: data.Invoice,
      quickbooks: data,
      inventario: inventarioActualizado,
      email,
    });
  } catch (error) {
    console.log("ERROR CREANDO FACTURA:");
    console.log(error.response?.data || error.message || error);

    res.status(500).json({
      error: "Error creando factura",
      detalle: error.response?.data || error.message || String(error),
    });
  }
});
app.post("/enviar-factura-email", requiereRol("empleado", "jefe"), async (req, res) => {
  try {
    const { invoiceId, customerId, items } = req.body;

    if (!invoiceId) {
      return res.status(400).json({ error: "Falta invoiceId" });
    }

    if (!customerId) {
      return res.status(400).json({ error: "Falta customerId" });
    }

    const invoiceData = await qboGet(`/invoice/${invoiceId}?minorversion=75`);
    const invoice = invoiceData.Invoice;

    const customerData = await qboGet(
      `/query?query=${encodeURIComponent(
        `SELECT * FROM Customer WHERE Id = '${customerId}'`
      )}&minorversion=75`
    );

    const cliente = customerData.QueryResponse?.Customer?.[0] || null;

    const resultado = await enviarFacturaPorCorreo({
      clienteEmail: obtenerEmailCliente(cliente),
      clienteNombre:
        cliente?.DisplayName || cliente?.FullyQualifiedName || "Cliente",
      bossEmail: process.env.BOSS_EMAIL || process.env.JEFE_EMAIL || "",
      invoice,
      items: items || [],
    });

    res.json({
      success: true,
      email: resultado,
    });
  } catch (error) {
    console.log("ERROR ENVIANDO FACTURA POR EMAIL:");
    console.log(error.response?.data || error.message || error);

    res.status(500).json({
      error: "Error enviando factura por email",
      detalle: error.response?.data || error.message || String(error),
    });
  }
});

app.get("/barcodes", (req, res) => {
  try {
    res.json(leerBarcodes());
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Error leyendo barcodes",
      detalle: err.message || String(err),
    });
  }
});

app.post("/barcodes", requiereRol("empleado", "jefe"), (req, res) => {
  try {
    const nuevo = req.body || {};

    if (!nuevo.barcode && !nuevo.code && !nuevo.codigo) {
      return res.status(400).json({
        error: "Falta código de barras",
      });
    }

    const data = leerBarcodes();

    const barcode = normalizarBarcode(nuevo.barcode || nuevo.code || nuevo.codigo);
    const productCode = String(nuevo.productCode || nuevo.productCodigo || "").trim();
    let itemId = String(nuevo.itemId || nuevo.id || "").trim();
    const productName = nuevo.productName || nuevo.name || "";

    // El capturador conoce el código interno del catálogo, no siempre el Id
    // numérico de QuickBooks. Intentamos resolverlo una sola vez y guardamos
    // el Id real para que las búsquedas futuras agreguen el producto.
    if (productCode || productName) {
      const cache = leerCacheProductos();
      const items = cache?.data?.QueryResponse?.Item || [];
      const encontradoQbo = productoCachePorClave(productCode || productName, items);
      if (encontradoQbo?.Id) itemId = String(encontradoQbo.Id);
    }

    const existente = data.find((x) => {
      return normalizarBarcode(x.barcode || x.code || x.codigo) === barcode;
    });

    if (existente) {
      existente.itemId = itemId || existente.itemId;
      existente.productCode = productCode || existente.productCode || "";
      existente.productName = productName || existente.productName || "";
      existente.updatedAt = new Date().toISOString();
    } else {
      data.push({
        barcode,
        itemId,
        productCode,
        productName,
        createdAt: new Date().toISOString(),
      });
    }

    guardarBarcodes(data);

    res.json({
      success: true,
      barcode,
      itemId,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Error guardando barcode",
      detalle: err.message || String(err),
    });
  }
});

app.get("/barcode/:codigo", (req, res) => {
  try {
    const codigo = normalizarBarcode(req.params.codigo);
    const data = leerBarcodes();

    const encontrado = data.find((x) => {
      return normalizarBarcode(x.barcode || x.code || x.codigo) === codigo;
    });

    if (!encontrado) {
      return res.status(404).json({
        error: "Código no encontrado",
      });
    }

    res.json(encontrado);
  } catch (error) {
    res.status(500).json({
      error: "Error buscando barcode",
      detalle: error.message || String(error),
    });
  }
});

app.post("/buscar-por-barcode", async (req, res) => {
  try {
    const codigo = normalizarBarcode(req.body.codigo || req.body.barcode);

    if (!codigo) {
      return res.status(400).json({
        error: "Falta código de barras",
      });
    }

    const data = leerBarcodes();

    const encontrado = data.find((x) => {
      return normalizarBarcode(x.barcode || x.code || x.codigo) === codigo;
    });

    if (!encontrado) {
      return res.status(404).json({
        error: "Código no registrado",
      });
    }

    let producto = null;
    if (/^\d+$/.test(String(encontrado.itemId))) {
      const query = encodeURIComponent(
        `SELECT * FROM Item WHERE Id = '${encontrado.itemId}'`
      );
      try {
        const productoData = await qboGet(`/query?query=${query}&minorversion=75`);
        producto = productoData.QueryResponse?.Item?.[0] || null;
      } catch (error) {
        console.warn("No se pudo consultar el Item de QBO; usando caché:", error.message || error);
      }
    }

    // Respaldo para códigos guardados antes de conocer el Id numérico de QBO.
    if (!producto) {
      const cache = leerCacheProductos();
      const items = cache?.data?.QueryResponse?.Item || [];
      producto = productoCachePorClave(
        encontrado.productCode || encontrado.productName || encontrado.itemId,
        items
      );
    }

    if (!producto && (encontrado.productCode || encontrado.productName)) {
      producto = {
        Id: encontrado.itemId || encontrado.productCode || encontrado.productName,
        Name: encontrado.productName || encontrado.productCode,
        FullyQualifiedName: encontrado.productName || encontrado.productCode,
        Sku: encontrado.productCode || "",
        Description: encontrado.productName || "",
      };
    }

    if (!producto) {
      return res.status(404).json({
        error: "Producto no encontrado en QuickBooks",
      });
    }

    res.json({
      success: true,
      barcode: codigo,
      producto,
    });
  } catch (error) {
    console.log("ERROR BUSCANDO POR BARCODE:");
    console.log(error.response?.data || error.message || error);

    res.status(500).json({
      error: "Error buscando por barcode",
      detalle: error.response?.data || error.message || String(error),
    });
  }
});app.post("/voice-transcribe", requiereRol("jefe", "empleado"), uploadAudio.single("audio"), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "Falta configurar OPENAI_API_KEY en Railway" });
    if (!req.file) return res.status(400).json({ error: "No se recibió audio" });
    if (!req.file.buffer || req.file.buffer.length < 100) return res.status(400).json({ error: "La grabación llegó vacía o incompleta. Vuelve a intentarlo." });
    const nombreAudio = String(req.file.originalname || "orden.wav").trim() || "orden.wav";
    const extensionAudio = (nombreAudio.split(".").pop() || "wav").toLowerCase();
    const tiposAudio = {
      wav: "audio/wav",
      webm: "audio/webm",
      mp3: "audio/mpeg",
      mp4: "audio/mp4",
      m4a: "audio/mp4",
      ogg: "audio/ogg",
      flac: "audio/flac",
    };
    const tipoAudio = tiposAudio[extensionAudio] || String(req.file.mimetype || "audio/wav");
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: tipoAudio }), nombreAudio);
    form.append("model", OPENAI_TRANSCRIBE_MODEL);
    form.append("language", "es");
    form.append("prompt", "Comandos de Distribuidora L&P para pedidos o inventario. Conserva exactamente las cantidades y los nombres de productos, marcas y salsas. Ejemplos de inventario: 20 Salsa Huichol, 6 Tapatío, 10 onzas. Puede incluir Sabritas, Cheetos, Doritos, Barcel, Tostitos, Galletas, Bebidas, Abarrotes y Dulces. No traduzcas los nombres propios.");
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method:"POST", headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}` }, body:form });
    const data=await response.json().catch(()=>({}));
    if(!response.ok) return res.status(response.status).json({ error:"OpenAI no pudo transcribir el audio", detalle:data, codigo:data?.error?.code||data?.error?.type||response.status });
    res.json({ ok:true, texto:String(data.text||"").trim(), modelo:OPENAI_TRANSCRIBE_MODEL });
  } catch(error) { console.error("ERROR TRANSCRIBIENDO VOZ:",error.message||error); res.status(500).json({ error:"No se pudo procesar la voz", detalle:error.message||String(error) }); }
});

app.post("/voice-command", async (req, res) => {
  try {
    const textoOriginal = String(req.body.texto || req.body.text || "").trim();
    const texto = limpiarTexto(textoOriginal);

    if (!texto) {
      return res.status(400).json({
        error: "Falta comando de voz",
      });
    }

    res.json({
      success: true,
      textoOriginal,
      textoLimpio: texto,
      mensaje: "Comando recibido",
    });
  } catch (error) {
    res.status(500).json({
      error: "Error procesando comando de voz",
      detalle: error.message || String(error),
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Ruta no encontrada",
    ruta: req.originalUrl,
  });
});

app.use((err, req, res, next) => {
  console.log("ERROR GENERAL DEL SERVIDOR:");
  console.log(err);

  res.status(500).json({
    error: "Error interno del servidor",
    detalle: err.message || String(err),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("=================================");
  console.log("SERVIDOR CORRIENDO");
  console.log("PUERTO:", PORT);
  console.log("MODO:", process.env.QBO_ENVIRONMENT || "sandbox");
  console.log("REDIRECT:", REDIRECT_URI);
  console.log("CORREO JEFE:", process.env.BOSS_EMAIL || process.env.JEFE_EMAIL || "NO CONFIGURADO");
  console.log("SMTP:", process.env.SMTP_HOST ? "CONFIGURADO" : "NO CONFIGURADO");
  console.log("=================================");
});

const productosSyncTimer = setInterval(() => {
  void actualizarCacheProductos();
}, PRODUCTS_CACHE_TTL_MS);
productosSyncTimer.unref?.();

const qboInventarioSyncTimer = setInterval(() => {
  void sincronizarFacturasQboRecientes();
}, QBO_INVENTORY_POLL_INTERVAL_MS);
qboInventarioSyncTimer.unref?.();

const qboInventarioReconcileTimer = setInterval(() => {
  void sincronizarFacturasQboRecientes({ reconciliar: true });
}, QBO_INVENTORY_RECONCILE_INTERVAL_MS);
qboInventarioReconcileTimer.unref?.();
void sincronizarFacturasQboRecientes();
