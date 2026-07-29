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
const PRODUCTS_CACHE_FILE = path.join(PERSISTENT_DATA_DIR, "productos-qbo-cache.json");
const PRODUCTS_CACHE_TTL_MS = 60 * 1000;

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
const PORT = process.env.PORT || 3000;
// El token debe vivir en el volumen de Railway para sobrevivir despliegues y reinicios.
const TOKEN_FILE = path.join(PERSISTENT_DATA_DIR, "qbo-token.json");
const ORDERS_FILE = path.join(PERSISTENT_DATA_DIR, "orders.json");
const BARCODES_FILE = "barcodes.json";

const REDIRECT_URI =
  process.env.REDIRECT_URI || "http://localhost:3000/callback";

app.use(cors());
app.use(express.json({ limit: "20mb" }));
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
  "/catalogo-local",
];

app.use((req, res, next) => {
  const protegida = RUTAS_PROTEGIDAS.some(
    (ruta) => req.path === ruta || req.path.startsWith(`${ruta}/`)
  );
  return protegida ? requiereSesion(req, res, next) : next();
});

app.get("/api/imagenes-productos", (req, res) => {
  res.json(leerMapaImagenes());
});
app.get("/api/categorias-productos", (req, res) => {
  res.json(leerMapaCategorias());
});
app.post("/api/productos/:id/categoria", requiereRol("jefe"), (req, res) => {
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

async function obtenerTokenValido() {
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
  }
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

    const barcode = String(nuevo.barcode || nuevo.code || nuevo.codigo).trim();
    const itemId = String(nuevo.itemId || nuevo.id || "").trim();

    const existente = data.find((x) => {
      return String(x.barcode || x.code || x.codigo || "").trim() === barcode;
    });

    if (existente) {
      existente.itemId = itemId || existente.itemId;
      existente.productName =
        nuevo.productName || nuevo.name || existente.productName || "";
      existente.updatedAt = new Date().toISOString();
    } else {
      data.push({
        barcode,
        itemId,
        productName: nuevo.productName || nuevo.name || "",
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
    const codigo = String(req.params.codigo || "").trim();
    const data = leerBarcodes();

    const encontrado = data.find((x) => {
      return String(x.barcode || x.code || x.codigo || "").trim() === codigo;
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
    const codigo = String(req.body.codigo || req.body.barcode || "").trim();

    if (!codigo) {
      return res.status(400).json({
        error: "Falta código de barras",
      });
    }

    const data = leerBarcodes();

    const encontrado = data.find((x) => {
      return String(x.barcode || x.code || x.codigo || "").trim() === codigo;
    });

    if (!encontrado || !encontrado.itemId) {
      return res.status(404).json({
        error: "Código no registrado",
      });
    }

    const query = encodeURIComponent(
      `SELECT * FROM Item WHERE Id = '${encontrado.itemId}'`
    );

    const productoData = await qboGet(`/query?query=${query}&minorversion=75`);
    const producto = productoData.QueryResponse?.Item?.[0] || null;

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
});app.post("/voice-command", async (req, res) => {
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
