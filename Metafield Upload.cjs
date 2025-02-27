const fs = require('fs');
const path = require('path');
const os = require('os');
const csv = require('csv-parser');
const axios = require('axios');
const ftp = require('basic-ftp');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// Shopify configuration constants
const SHOPIFY_URL = 'https://****.myshopify.com/admin/api/2024-01/graphql.json';
const SHOPIFY_ACCESS_TOKEN = '*******';
const fileName = 'metafield_for_upload.csv';
const ftpFolderPath = '/In/Plytix/Upload/';
const tempDir = os.tmpdir();
const localFilePath = path.join(tempDir, fileName);
const logFileName = 'upload_metafields_log.csv';  // Use a consistent filename
const logFilePath = path.join(tempDir, logFileName); // Use the same variable for logging and uploading

// Metafield type mapping
const metafieldTypeMapping = {
    "seo_title": "single_line_text_field",
    "seo_description": "single_line_text_field",
    "product_colour": "single_line_text_field",
    "primary_colour": "single_line_text_field"
};

function cleanColumnName(columnName) {
    return columnName.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

// Download the CSV file from the FTP server
async function listFTPFiles() {
    const client = new ftp.Client();
    client.ftp.verbose = true;
    try {
        console.log('Connecting to FTP server...');
        await client.access({
            host: "ftp.tcgroupuk.com",
            port: "21",
            user: "Shopify",
            password: "muddycloud25",
            secure: false
        });
        console.log('Connected to FTP server. Downloading file...');
        await client.downloadTo(localFilePath, path.join(ftpFolderPath, fileName));
        console.log(`File downloaded to ${localFilePath}`);
    } catch (err) {
        console.error('Error downloading file from FTP:', err);
    } finally {
        client.close();
    }
}

// Process the CSV file
async function processCSV(filePath) {
    const results = [];
    return new Promise((resolve, reject) => {
        console.log('Processing CSV file...');
        fs.createReadStream(filePath)
            .pipe(csv({
                mapHeaders: ({ header }) => cleanColumnName(header)
            }))
            .on('data', (data) => {
                results.push(data);
            })
            .on('end', () => {
                resolve(results);
            })
            .on('error', (error) => {
                console.error('Error processing CSV file:', error);
                reject(error);
            });
    });
}

async function logToFile(logData) {
    const logEntries = logData.map(entry => ({
        SKU: entry.sku,
        Status: entry.status
    }));
    const csvContent = stringify(logEntries, { header: true });
    fs.writeFileSync(logFilePath, csvContent, 'utf8');  // Write to logFilePath
}

// Upload the log file back to the FTP server
async function uploadMetafieldsLogFile() {
    const client = new ftp.Client();
    client.ftp.verbose = true;
    const localLogFilePath = logFilePath;  // Refer to the same logFilePath
    const remoteLogFilePath = '/In/Plytix/Logs/' + logFileName;  // Ensure path consistency

    try {
        if (fs.existsSync(localLogFilePath)) {  // Check if the file exists before uploading
            await client.access({
                host: "**",
                port: "**",
                user: "***",
                password: "****,
                secure: false
            });
            await client.uploadFrom(localLogFilePath, remoteLogFilePath);
            console.log(`Log file successfully uploaded to ${remoteLogFilePath}`);
        } else {
            console.error('File does not exist:', localLogFilePath);
        }
    } catch (err) {
        console.error('Error uploading log file to FTP:', err);
    } finally {
        client.close();
    }
}


// Upload metafields to Shopify
async function uploadMetafields(variantId, metafields, sku, logData) {
    const mutation = `
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                metafields {
                    id
                    namespace
                    key
                    value
                    type
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    const metafieldData = {
        metafields: metafields.map(metafield => ({
            ownerId: variantId,
            namespace: metafield.namespace,
            key: metafield.key,
            value: metafield.value.toString(),
            type: metafield.type
        }))
    };

    try {
        const response = await axios.post(SHOPIFY_URL, {
            query: mutation,
            variables: metafieldData
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            }
        });
        console.log('Raw API Response:', JSON.stringify(response.data, null, 2));
        if (response.data.errors) {
            logData.push({
                sku: sku,
                status: 'fail'
            });
            return null;
        }
        return response.data.data.metafieldsSet.metafields;
    } catch (error) {
        logData.push({
            sku: sku,
            status: 'fail'
        });
    }
}
// Get variant ID by SKU
async function getVariantIDBySKU(sku) {
    const query = `
        query GetVariantIdBySku {
            productVariants(first: 1, query: "sku:${sku}") {
                edges {
                    node {
                        id
                    }
                }
            }
        }
    `;

    try {
        const response = await axios.post(SHOPIFY_URL, {
            query: query
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
        });

        const data = response.data;
        if (data.errors) {
            return null;
        }

        const variant = data.data?.productVariants?.edges[0]?.node;
        return variant ? variant.id : null;
    } catch (error) {
        console.error('Error fetching variant ID by SKU:', error);
        return null;
    }
}

// Group rows by a key
function groupBy(array, key) {
    return array.reduce((result, currentValue) => {
        (result[currentValue[key]] = result[currentValue[key]] || []).push(currentValue);
        return result;
    }, {});
}

// Main function
async function main() {
    // Step 1: Download the file from the FTP server
    await listFTPFiles();

    // Step 2: Process the CSV file
    const csvRows = await processCSV(localFilePath);
    const productGroups = groupBy(csvRows, 'Handle');
    const logData = [];

    // Step 3: Process each product and upload metafields
    for (const [handle, rows] of Object.entries(productGroups)) {
        for (const row of rows) {
            const sku = row["Variant SKU"];
            const variantId = await getVariantIDBySKU(sku);
            if (!variantId) {
                logData.push({
                    sku: sku,
                    status: 'fail'
                });
                continue;
            }

            const metafields = Object.keys(row)
                .filter(key => key !== "Handle" && key !== "Variant SKU" && row[key]) // Skip empty values
                .map(key => ({
                    namespace: 'main',
                    key: key.replace(/ /g, '_').toLowerCase(),
                    value: row[key] ? row[key].toString() : '',
                    type: metafieldTypeMapping[key.replace(/ /g, '_').toLowerCase()] || 'single_line_text_field'
                }));

            // Chunk metafields into batches of 25 to comply with GraphQL API limits
            const chunkSize = 25;
            for (let i = 0; i < metafields.length; i += chunkSize) {
                const chunk = metafields.slice(i, i + chunkSize);
                await uploadMetafields(variantId, chunk, sku, logData);
            }
        }
    }

    // Step 4: Log API calls to a CSV file
    if(logData) {
      await logToFile(logData);
    }

    // Step 5: Upload the log file to the FTP server
    await uploadMetafieldsLogFile()
}

main().catch(error => {
    console.error('Error during execution:', error);
});
