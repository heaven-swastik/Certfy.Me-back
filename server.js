/* ---------------------------------------------------
   CERTFY.ME BACKEND  – FINAL CLEAN VERSION
--------------------------------------------------- */

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const sharp = require('sharp');
const archiver = require('archiver');
const csv = require('csv-parser');
const path = require('path');
const stream = require('stream');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

/* ---------------------------------------------------
   CORS FIXED – ALLOW NETLIFY FRONTEND
--------------------------------------------------- */
app.use(cors({
    origin: [
        "http://localhost:3000",
        "https://certfyme.netlify.app",
    ],
    methods: ["GET", "POST"],
    credentials: true
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

/* ---------------------------------------------------
   MULTER (Memory Storage)
--------------------------------------------------- */
const storage = multer.memoryStorage();
const upload = multer({ storage });

/* ---------------------------------------------------
   GOOGLE FONTS API
--------------------------------------------------- */
const GOOGLE_FONTS_API_KEY = process.env.GOOGLE_FONTS_API_KEY;
const FONT_LIST_URL = `https://www.googleapis.com/webfonts/v1/webfonts?key=${GOOGLE_FONTS_API_KEY}&sort=popularity`;

/* ---------------------------------------------------
   DOWNLOAD GOOGLE FONT
--------------------------------------------------- */
const downloadFontFile = async (url) => {
    try {
        const ttfUrl = url.replace("woff2", "ttf");

        const response = await axios.get(ttfUrl, { responseType: "arraybuffer" });
        const mimeType = ttfUrl.includes(".otf") ? "font/otf" : "font/ttf";

        return { buffer: Buffer.from(response.data), mimeType };

    } catch (err) {
        console.log("Google Font Download Failed:", err.message);
        return null;
    }
};

/* ---------------------------------------------------
   GET GOOGLE FONTS
--------------------------------------------------- */
app.get("/api/fonts", async (req, res) => {
    try {
        const response = await axios.get(FONT_LIST_URL);
        const fonts = response.data.items.map(font => ({
            family: font.family,
            files: font.files,
            category: font.category,
        }));

        res.json(fonts);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch Google fonts" });
    }
});

/* ---------------------------------------------------
   GENERATE CERTIFICATES
--------------------------------------------------- */
app.post(
    "/generate",
    upload.fields([
        { name: "template" },
        { name: "csv" },
        { name: "customFont", maxCount: 1 }
    ]),
    async (req, res) => {

        console.log("Request received...");

        const { x, y, fontSize, fontColor, fontFamily, fontUrl } = req.body;

        if (!req.files || !req.files.template || !req.files.csv) {
            return res.status(400).json({ error: "Missing template or CSV file" });
        }

        const templateBuffer = req.files.template[0].buffer;
        const csvBuffer = req.files.csv[0].buffer;
        const customFontFile = req.files.customFont?.[0];

        /* ---------------------------------------------------
           PARSE CSV
        --------------------------------------------------- */
        const csvData = [];

        await new Promise((resolve, reject) => {
            const readable = new stream.Readable();
            readable._read = () => {};
            readable.push(csvBuffer);
            readable.push(null);

            readable.pipe(csv())
                .on("data", row => {
                    const name = Object.values(row)[0];
                    if (name?.trim()) csvData.push(name.trim());
                })
                .on("end", resolve)
                .on("error", reject);
        });

        if (csvData.length === 0) {
            return res.status(400).json({ error: "CSV is empty" });
        }

        /* ---------------------------------------------------
           FONT HANDLING
        --------------------------------------------------- */
        let fontCSS = "";
        let fontStack = `'${fontFamily}', sans-serif`;

        if (customFontFile) {
            const buffer = customFontFile.buffer;
            const base64 = buffer.toString("base64");
            const mime = customFontFile.originalname.endsWith(".otf") ? "font/otf" : "font/ttf";

            fontCSS = `
            @font-face {
                font-family: "CustomFont";
                src: url(data:${mime};base64,${base64}) format("truetype");
            }`;

            fontStack = `"CustomFont"`;
        }

        else if (fontUrl) {
            const fontData = await downloadFontFile(fontUrl);
            if (fontData) {
                const base64 = fontData.buffer.toString("base64");

                fontCSS = `
                @font-face {
                    font-family: "${fontFamily}";
                    src: url(data:${fontData.mimeType};base64,${base64}) format("truetype");
                }`;

                fontStack = `"${fontFamily}"`;
            }
        }

        /* ---------------------------------------------------
           PREP ZIP
        --------------------------------------------------- */
        const archive = archiver("zip", { zlib: { level: 9 } });
        const output = new stream.PassThrough();
        archive.pipe(output);

        const meta = await sharp(templateBuffer).metadata();
        const tW = meta.width;
        const tH = meta.height;

        const base64Template = templateBuffer.toString("base64");
        const templateMime = req.files.template[0].mimetype;

        /* ---------------------------------------------------
           GENERATE EACH CERTIFICATE
        --------------------------------------------------- */
        for (const name of csvData) {
            const svg = `
                <svg width="${tW}" height="${tH}" xmlns="http://www.w3.org/2000/svg">
                    <style>
                        ${fontCSS}
                        .t {
                            font-family: ${fontStack};
                            font-size: ${fontSize}px;
                            fill: ${fontColor};
                            text-anchor: middle;
                            dominant-baseline: middle;
                        }
                    </style>

                    <image href="data:${templateMime};base64,${base64Template}" width="${tW}" height="${tH}" />
                    <text x="${x}" y="${y}" class="t">${name}</text>
                </svg>
            `;

            const png = await sharp(Buffer.from(svg)).png().toBuffer();
            archive.append(png, { name: `${name.replace(/[^a-z0-9]/gi, "_")}.png` });
        }

        archive.finalize();

        res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="batch.zip"',
        });

        output.pipe(res);
    }
);

/* ---------------------------------------------------
   START SERVER
--------------------------------------------------- */
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

