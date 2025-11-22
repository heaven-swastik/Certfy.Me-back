// --- server.js (FIXED) ---
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const sharp = require('sharp');
const archiver = require('archiver');
const csv = require('csv-parser');
const path = require('path');
const stream = require('stream');
const cors = require('cors');

// ... (Environment setup and constants remain the same) ...
require('dotenv').config({ path: path.resolve(__dirname, 'doc.env') }); 
const GOOGLE_FONTS_API_KEY = process.env.GOOGLE_FONTS_API_KEY; 
const FONT_LIST_URL = `https://www.googleapis.com/webfonts/v1/webfonts?key=${GOOGLE_FONTS_API_KEY}&sort=popularity`;

const app = express();
const PORT = 5001;

app.use(cors({ origin: 'http://localhost:3000', methods: ['GET', 'POST'], credentials: true }));
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Downloads a font file buffer from a URL (used for Google Fonts)
const downloadFontFile = async (url) => {
    try {
        // IMPORTANT: Google Fonts serves WOFF2 by default which Sharp doesn't support well. 
        // We ensure we only download the TTF version if the link allows.
        const ttfUrl = url.replace('woff2', 'ttf'); // Simple attempt to get TTF
        const response = await axios.get(ttfUrl, { responseType: 'arraybuffer' });
        
        // Determine file extension for MIME type
        const mimeType = ttfUrl.includes('.otf') ? 'font/otf' : 'font/ttf';

        return { buffer: Buffer.from(response.data), mimeType };
    } catch (error) {
        console.error(`Failed to download Google font from ${url}:`, error.message);
        return null;
    }
};

// 1. Fetch Google Fonts List (No change needed here)
app.get('/api/fonts', async (req, res) => {
    try {
        const response = await axios.get(FONT_LIST_URL);
        const fonts = response.data.items.map(font => ({
            family: font.family,
            files: font.files,
            category: font.category,
        }));
        res.json(fonts);
    } catch (error) {
        console.error("Error fetching Google Fonts:", error.message);
        res.status(500).json({ error: 'Failed to fetch font list from Google API.' });
    }
});


// 2. Main Generation Route (FIXED FONT LOGIC)
app.post('/generate', upload.fields([
    { name: 'template' }, 
    { name: 'csv' },
    { name: 'customFont', maxCount: 1 }
]), async (req, res) => {
    console.log("--- Generation Request Received ---");
    const { x, y, fontSize, fontColor, fontFamily, fontUrl } = req.body;
    
    const xPos = parseFloat(x);
    const yPos = parseFloat(y);
    const size = parseFloat(fontSize);
    
    if (!req.files || !req.files.template || !req.files.csv) {
        return res.status(400).json({ error: 'Missing template image or CSV file.' });
    }

    const templateBuffer = req.files.template[0].buffer;
    const csvBuffer = req.files.csv[0].buffer;
    const customFontFile = req.files.customFont ? req.files.customFont[0] : null;

    // --- CSV Parsing (No change needed) ---
    const csvData = [];
    try {
        await new Promise((resolve, reject) => {
            const readableStream = new stream.Readable();
            readableStream._read = () => {}; 
            readableStream.push(csvBuffer);
            readableStream.push(null);
            readableStream.pipe(csv()).on('data', (row) => {
                const name = Object.values(row)[0];
                if (name && name.trim()) csvData.push(name.trim());
            }).on('end', resolve).on('error', reject);
        });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to parse CSV file.' });
    }
    
    if (csvData.length === 0) {
        return res.status(400).json({ error: 'CSV file contains no usable names.' });
    }

    // --- Font Handling (CRITICAL FIX) ---
    let fontCSS = '';
    let fontStack = `'${fontFamily || 'Arial'}', sans-serif`; 
    
    try {
        if (customFontFile) {
            // 1. Custom Font Upload Logic
            const fontBuffer = customFontFile.buffer;
            const fontBase64 = fontBuffer.toString('base64');
            const fontMime = customFontFile.originalname.endsWith('.otf') ? 'font/otf' : 'font/ttf';
            const internalName = "CustomCertFont"; // Always use a simple internal name

            fontStack = `'${internalName}'`;
            fontCSS = `
                @font-face {
                    font-family: '${internalName}';
                    src: url("data:${fontMime};base64,${fontBase64}") format('truetype');
                    font-weight: normal; 
                    font-style: normal;
                }
            `;
            console.log("Using custom uploaded font:", customFontFile.originalname);

        } else if (fontUrl) {
            // 2. Google Font Download Logic
            const fontData = await downloadFontFile(fontUrl); 
            
            if (fontData) {
                const { buffer: fontBuffer, mimeType: fontMime } = fontData;
                const fontBase64 = fontBuffer.toString('base64');
                const internalName = fontFamily; 
                
                fontStack = `'${internalName}'`;
                fontCSS = `
                    @font-face {
                        font-family: '${internalName}';
                        src: url("data:${fontMime};base64,${fontBase64}") format('truetype');
                        font-weight: normal; 
                        font-style: normal;
                    }
                `;
                console.log(`Using downloaded Google Font: ${fontFamily}`);
            } else {
                console.warn(`Font download failed for ${fontFamily}, using default system font.`);
            }
        }
        
        // 3. Fallback for System Fonts (if no file/url was sent)
        if (!fontCSS) {
             fontStack = `'${fontFamily}', sans-serif`; // Use font stack as is
             console.log(`Using generic system font: ${fontFamily}`);
        }

    } catch(err) {
        console.error("Critical error during font handling:", err);
        return res.status(500).json({ error: 'Font embedding failed on the server.' });
    }


    // --- Batch Generation (FIXED SVG) ---
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = new stream.PassThrough();
    archive.pipe(output);

    const base64Template = templateBuffer.toString('base64');
    const templateMime = req.files.template[0].mimetype;
    
    // Determine image size for SVG (to prevent resizing/scaling issues)
    const metadata = await sharp(templateBuffer).metadata();
    const { width: templateW, height: templateH } = metadata;

    for (const name of csvData) {
        // Use exact dimensions from template for the SVG viewbox
        const svg = `
            <svg width="${templateW}" height="${templateH}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
                <style>
                    /* FONT EMBEDDING (CRITICAL) */
                    ${fontCSS}
                    
                    .text {
                        font-family: ${fontStack};
                        font-size: ${size}px;
                        fill: ${fontColor};
                        /* SVG Alignment properties: text-anchor: middle and dominant-baseline: middle center the text block at (x,y) */
                        text-anchor: middle;
                        dominant-baseline: middle; 
                        text-shadow: 1px 1px 2px rgba(0,0,0,0.2);
                    }
                </style>
                <image xlink:href="data:${templateMime};base64,${base64Template}" width="${templateW}" height="${templateH}" />
                <text x="${xPos}" y="${yPos}" class="text">${name}</text>
            </svg>
        `;

        try {
            const pngBuffer = await sharp(Buffer.from(svg))
                .png()
                .toBuffer();
            
            archive.append(pngBuffer, { name: `${name.replace(/[^a-z0-9]/gi, '_')}.png` });
        } catch (error) {
            console.error(`Error processing SVG for ${name}:`, error.message);
        }
    }

    // 2d. Finalize and Send ZIP
    archive.finalize();

    res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="Certificates_Batch.zip"`,
    });
    output.pipe(res);
    console.log("--- Generation Complete & ZIP Sent ---");
});

// --- SERVER START ---
app.listen(PORT, () => {
    console.log(`Backend Core Online: http://localhost:${PORT}`);
});