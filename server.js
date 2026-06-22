require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const OAuthClient = require("intuit-oauth");

const app = express();

const PORT = 3000;
const TOKEN_FILE = "qbo-token.json";
const ORDERS_FILE = "orders.json";
const BARCODES_FILE = "barcodes.json";
const REDIRECT_URI =
  process.env.REDIRECT_URI || "http://localhost:3000/callback";

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const oauthClient = new OAuthClient({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  environment: process.env.QBO_ENVIRONMENT,
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
    console.log("NO SE PUDO REFRESCAR TOKEN, USANDO TOKEN ACTUAL:");
    console.log(JSON.stringify(error.response?.data || error.message || error, null, 2));
    return token;
  }
}

async function qboGet(pathUrl) {
  const token = await obtenerTokenValido();
  const url = `https://quickbooks.api.intuit.com/v3/company/${token.realmId}${pathUrl}`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json",
    },
  });

  return response.data;
}

async function qboPost(pathUrl, body) {
  const token = await obtenerTokenValido();
  const url = `https://quickbooks.api.intuit.com/v3/company/${token.realmId}${pathUrl}`;

  const response = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  return response.data;
}

function leerOrdenes() {
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2));
  }
  return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
}

function guardarOrdenes(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/connect-qbo", (req, res) => {
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: "LandPReal",
  });

  console.log("AUTH URL:");
  console.log(authUri);

  res.redirect(authUri);
});

app.get("/callback", async (req, res) => {
  try {
    console.log("CALLBACK RECIBIDO:");
    console.log(req.url);

    const authResponse = await oauthClient.createToken(req.url);
    const token = authResponse.getJson();

    token.realmId = req.query.realmId;

    guardarToken(token);

    console.log("TOKEN GUARDADO:", TOKEN_FILE);
    console.log("REALM ID:", token.realmId);

    res.send("QUICKBOOKS CONECTADO CORRECTAMENTE");
  } catch (error) {
    console.log("ERROR OAUTH:");
    console.log(JSON.stringify(error.response?.data || error.message || error, null, 2));
    res.status(500).send("ERROR OAUTH");
  }
});

app.get("/clientes", async (req, res) => {
  try {
    const query = encodeURIComponent("SELECT * FROM Customer MAXRESULTS 1000");
    const data = await qboGet(`/query?query=${query}&minorversion=75`);
    res.json(data);
  } catch (error) {
    console.log("ERROR CLIENTES:");
    console.log(JSON.stringify(error.response?.data || error.message || error, null, 2));
    res.status(500).json({
      error: "Error obteniendo clientes",
      detalle: error.response?.data || error.message || error,
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
    console.log(JSON.stringify(error.response?.data || error.message || error, null, 2));
    res.status(500).json({
      error: "Error obteniendo productos",
      detalle: error.response?.data || error.message || error,
    });
  }
});

app.get("/orders", (req, res) => {
  try {
    res.json(leerOrdenes());
  } catch (error) {
    res.status(500).json({ error: "Error leyendo órdenes" });
  }
});

app.post("/orders", (req, res) => {
  try {
    const orders = leerOrdenes();

    const newOrder = {
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      customer: req.body.customer || null,
      items: req.body.items || [],
      status: "pending",
    };

    orders.push(newOrder);
    guardarOrdenes(orders);

    res.json(newOrder);
  } catch (error) {
    res.status(500).json({ error: "Error guardando orden" });
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
        value: customerId,
      },
 Line: items.map((item) => {
  const qty = Number(item.qty || item.quantity || 1);
  const unitPrice = Number(item.unitPrice || item.price || 0);

  return {
    DetailType: "SalesItemLineDetail",
    Amount: Number((qty * unitPrice).toFixed(2)),
    SalesItemLineDetail: {
      ItemRef: {
        value: item.itemId,
      },
      Qty: qty,
      UnitPrice: unitPrice,
    },
  };
}),
    };
console.log(JSON.stringify(invoice, null, 2));
    const data = await qboPost("/invoice?minorversion=75", invoice);

    res.json(data);
  } catch (error) {
    console.log("ERROR CREANDO FACTURA:");
    console.log(JSON.stringify(error.response?.data || error.message || error, null, 2));
    res.status(500).json({
      error: "Error creando factura",
      detalle: error.response?.data || error.message || error,
    });
  }
});
// ===============================
// BARCODES
// ===============================

app.get("/barcodes", (req, res) => {
  try {
    if (!fs.existsSync(BARCODES_FILE)) {
      return res.json([]);
    }

    const data = JSON.parse(
      fs.readFileSync(BARCODES_FILE, "utf8")
    );

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Error leyendo barcodes"
    });
  }
});

app.post("/barcodes", (req, res) => {
  try {
    const nuevo = req.body;

    let data = [];

    if (fs.existsSync(BARCODES_FILE)) {
      data = JSON.parse(
        fs.readFileSync(BARCODES_FILE, "utf8")
      );
    }

    data.push(nuevo);

    fs.writeFileSync(
      BARCODES_FILE,
      JSON.stringify(data, null, 2)
    );

    res.json({
      success: true
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Error guardando barcode"
    });
  }
});
app.listen(PORT, () => {
  console.log("=================================");
  console.log("SERVIDOR CORRIENDO");
  console.log("PUERTO:", PORT);
  console.log("MODO: PRODUCCION REAL");
  console.log("REDIRECT:", REDIRECT_URI);
  console.log("=================================");
});