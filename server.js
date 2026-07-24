require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const OAuthClient = require("intuit-oauth");
const nodemailer = require("nodemailer");
const multer = require("multer");
const app = express();
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "images", "productos"));
  },
  filename: (req, file, cb) => {
    const nombre = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, nombre);
  }
});

const upload = multer({ storage });
const PORT = process.env.PORT || 3000;
const TOKEN_FILE = "qbo-token.json";
const ORDERS_FILE = "orders.json";
const BARCODES_FILE = "barcodes.json";

const REDIRECT_URI =
  process.env.REDIRECT_URI || "http://localhost:3000/callback";

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));
app.get("/api/imagenes-disponibles", (req, res) => {
  try {
    const carpeta = path.join(__dirname, "images", "productos");

    const imagenes = fs
      .readdirSync(carpeta)
      .filter(nombre => /\.(jpg|jpeg|png|webp|gif)$/i.test(nombre))
      .sort();

    res.json(imagenes);
  } catch (error) {
    console.error("Error leyendo imágenes:", error);
    res.status(500).json({ error: "No se pudieron leer las imágenes" });
  }
});
app.post("/api/productos/:id/imagen", upload.single("imagen"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ninguna imagen" });
    }

    const id = String(req.params.id);
    const rutaImagen = `/images/productos/${req.file.filename}`;

    const archivoCatalogo = path.join(__dirname, "catalogo_maestro_sistema.json");
    const catalogo = JSON.parse(fs.readFileSync(archivoCatalogo, "utf8"));

const producto = catalogo.productos.find(
      p => String(p.Id || p.id) === id
    );

    if (!producto) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    producto.imagen = rutaImagen;

    fs.writeFileSync(
      archivoCatalogo,
      JSON.stringify(catalogo, null, 2),
      "utf8"
    );

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
    const nombre = item.name || item.description || item.itemName || "Producto";
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
      <p><strong>Factura:</strong> ${docNumber}</p>
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
    subject: `Factura Distribuidora L&P #${docNumber}`,
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
app.get("/connect-qbo", (req, res) => {
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
    const query = encodeURIComponent("SELECT * FROM Item MAXRESULTS 1000");
    const data = await qboGet(`/query?query=${query}&minorversion=75`);
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
    res.json(leerOrdenes());
  } catch (error) {
    res.status(500).json({
      error: "Error leyendo órdenes",
      detalle: error.message || String(error),
    });
  }
});

app.post("/orders", (req, res) => {
  try {
    const orders = leerOrdenes();

    const newOrder = {
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      customerId: req.body.customerId || req.body.customer?.id || null,
      customerName: req.body.customerName || req.body.customer?.name || null,
      customer: req.body.customer || null,
      items: req.body.items || [],
      status: "pending",
    };

    orders.push(newOrder);
    guardarOrdenes(orders);

    res.json(newOrder);
  } catch (error) {
    res.status(500).json({
      error: "Error guardando orden",
      detalle: error.message || String(error),
    });
  }
  });
app.post("/crear-factura", async (req, res) => {
  try {
    const { customerId, items } = req.body;

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

        if (!itemId) {
          throw new Error("Producto sin itemId");
        }

        return {
          DetailType: "SalesItemLineDetail",
          Amount: Number((qty * unitPrice).toFixed(2)),
          Description:
            item.description ||
            item.descripcion ||
            item.name ||
            item.nombre ||
            "",
          SalesItemLineDetail: {
            ItemRef: {
              value: String(itemId),
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

    res.json({
      success: true,
      invoice: data.Invoice,
      quickbooks: data,
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
app.post("/enviar-factura-email", async (req, res) => {
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

app.post("/barcodes", (req, res) => {
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