///////////////////////////////////////////////////////////////////
// TO DO :
// 
///////////////////////////////////////////////////////////////////
const fs = require('fs');
const path = require('path');
const os = require('os');
const csv = require('csv-parser');
const axios = require('axios');
const ftp = require('basic-ftp');
const { stringify } = require('csv-stringify/sync');
const file = 'product_for_upload.csv';
const ftpFolderPath = '/In/Plytix/Upload/';
const tempDir = os.tmpdir();
const localFilePath = path.join(tempDir, file);
const SHOPIFY_URL = 'https://****.myshopify.com/admin/api/2024-01/graphql.json';
const SHOPIFY_ACCESS_TOKEN = '******';


function cleanColumnName(columnName) {
    return columnName.replace(/^﻿/, '').replace(/[​-‍﻿]/g, '').trim();
}

function groupBy(array, key) {
    return array.reduce((result, currentValue) => {
        (result[currentValue[key]] = result[currentValue[key]] || []).push(currentValue);
        return result;
    }, {});
}

async function listFTPFiles() {
    const client = new ftp.Client();
    client.ftp.verbose = true;
    try {
        await client.access({
            host: "***,
            port: "**",
            user: "****",
            password: "****",
            secure: false,
        });
        await client.downloadTo(localFilePath, `${ftpFolderPath}${file}`);
        console.log(`File downloaded successfully to ${localFilePath}`);
    } catch (err) {
        console.error("Error downloading file from FTP:", err);
    } finally {
        client.close();
    }
}
async function processCSV(filePath) {
    const results = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv({ mapHeaders: ({ header }) => cleanColumnName(header) }))
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', reject);
    });
}

async function getProductIDByTitle(title) {
    const query = `
        query {
            products(first: 1, query: "title:'${title}'") {
                edges {
                    node {
                        id
                        options {
                            id
                            name
                            values
                        }
                        variants(first: 100) {
                            edges {
                                node {
                                    id
                                    sku
                                    selectedOptions {
                                        name
                                        value
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    try {
        const response = await axios.post(
            SHOPIFY_URL,
            { query },
            { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );


        const data = response.data;
        const product = data.data.products.edges[0]?.node;

        if (product) {
            // Map the variants with their selected option values
            const variants = product.variants.edges.map(edge => ({
                id: edge.node.id,
                sku: edge.node.sku,
                selectedOptions: edge.node.selectedOptions
            }));

            // Collect options with their names, values, and IDs
            const options = product.options.map(option => ({
                id: option.id,
                name: option.name,
                values: option.values
            }));

            return { productId: product.id, existingVariants: variants, options };
        } else {
            console.error('No product found with the specified title.');
            return null;
        }
    } catch (error) {
        console.error('Error fetching product by title:', error.message);
        return null;
    }
}



async function addVariantsToProduct(productId, newVariants) {
    const mutation = `
        mutation productVariantsBulkCreate(
            $productId: ID!, 
            $variants: [ProductVariantsBulkInput!]!, 
            $media: [CreateMediaInput!]
        ) {
            productVariantsBulkCreate(productId: $productId, variants: $variants, media: $media) {
                product {
                    id
                    media(first: 100) {
                        nodes {
                            id
                            alt
                            mediaContentType
                            preview {
                                status
                            }
                        }
                    }
                }
                productVariants {
                    id
                    sku
                    media(first: 10) {
                        nodes {
                            id
                            alt
                            mediaContentType
                            preview {
                                status
                            }
                        }
                    }
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    // Separate media input and variants
    const mediaInputs = [];
    const variantsInput = newVariants.map(variant => {
        if (variant.image) { 
            mediaInputs.push({
                originalSource: variant.image, 
                alt: `Image for SKU: ${variant.sku}`, 
                mediaContentType: "IMAGE"
            });
        }

        return {
            sku: variant.sku,
            barcode: variant.barcode,
            taxable: variant.taxable ?? true,
            inventoryPolicy: "CONTINUE",
            weight: variant.grams ? parseFloat(variant.grams) / 1000 : 0,
            weightUnit: "KILOGRAMS",
            optionValues: [
                { name: variant.option1, optionName: variant.option1name },
                { name: variant.option2, optionName: variant.option2name },
                { name: variant.option3, optionName: variant.option3name }
            ].filter(opt => opt.name && opt.optionName), // Ensure no empty values are sent
            mediaSrc: variant.image || null 
        };
    });

    const variables = {
        productId,
        variants: variantsInput,
        media: mediaInputs.length > 0 ? mediaInputs : null 
    };

    try {
        const response = await axios.post(
            SHOPIFY_URL,
            { query: mutation, variables },
            { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
        console.log('Raw API Response:', JSON.stringify(response.data, null, 2));
        const result = response.data;

        if (!result.data || !result.data.productVariantsBulkCreate) {
            throw new Error("Missing or undefined productVariantsBulkCreate in response.");
        }

        if (result.data.productVariantsBulkCreate.userErrors.length > 0) {
            throw new Error(result.data.productVariantsBulkCreate.userErrors.map(err => `${err.field}: ${err.message}`).join(', '));
        }

        return { success: true, variants: result.data.productVariantsBulkCreate.productVariants };
    } catch (error) {
        console.error('Error adding variants:', error);
        return { success: false, error: error.message };
    }
}




async function deleteVariants(productId, variantsIds) {
    const mutation = `
        mutation productVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
            productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    try {
        const response = await axios.post(
            SHOPIFY_URL,
            { query: mutation, variables: { productId, variantsIds } },
            { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
        //console.log('Raw API Response:', JSON.stringify(response.data, null, 2));
        const result = response.data;

        if (!result || !result.data || !result.data.productVariantsBulkDelete) {
            throw new Error('Invalid response structure from Shopify API');
        }

        const userErrors = result.data.productVariantsBulkDelete.userErrors;
        if (userErrors && userErrors.length > 0) {
            const errorMessages = userErrors.map(err => `${err.field}: ${err.message}`).join(', ');
            throw new Error(`Shopify API errors: ${errorMessages}`);
        }

        return { success: true };
    } catch (error) {
        console.error('Error deleting variants:', error.message || error);
        return { success: false, error: error.message };
    }
}
async function deleteMediaBySku(productId, sku) {
    const getProductMediaQuery = `
        query getProductMedia($productId: ID!) {
            product(id: $productId) {
                media(first: 100) {
                    edges {
                        node {
                            id
                            ... on MediaImage {
                                image {
                                    src
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    const deleteMediaMutation = `
        mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
            productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
                deletedMediaIds
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    try {
        // Step 1: Fetch all media for the product
        const mediaResponse = await axios.post(
            SHOPIFY_URL,
            {
                query: getProductMediaQuery,
                variables: { productId },
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
                },
            }
        );

        const mediaResult = mediaResponse.data;
        if (!mediaResult.data || !mediaResult.data.product || !mediaResult.data.product.media) {
            throw new Error("No media found for the product.");
        }

        // Step 2: Filter media containing the SKU in the URL
        const mediaToDelete = mediaResult.data.product.media.edges.filter((mediaEdge) =>
            mediaEdge.node.image?.src.includes(sku) // Match by SKU in the image URL
        );

        if (mediaToDelete.length === 0) {
            return { success: true, message: `No images found containing SKU: ${sku}` };
        }

        // Collect IDs of media to delete
        const mediaIdsToDelete = mediaToDelete.map((mediaEdge) => mediaEdge.node.id);

        // Step 3: Delete the media using productDeleteMedia
        const deleteResponse = await axios.post(
            SHOPIFY_URL,
            {
                query: deleteMediaMutation,
                variables: { productId, mediaIds: mediaIdsToDelete },
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
                },
            }
        );

        const deleteResult = deleteResponse.data;
        if (deleteResult.data.productDeleteMedia.userErrors.length > 0) {
            throw new Error(
                deleteResult.data.productDeleteMedia.userErrors
                    .map((err) => `${err.field}: ${err.message}`)
                    .join(", ")
            );
        }

        return {
            success: true,
            deletedMediaIds: deleteResult.data.productDeleteMedia.deletedMediaIds,
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
async function deleteProductAsync(productId, variantsIds) {
    const mutation = `
        mutation productDeleteAsync($productId: ID!) {
            productDeleteAsync(productId: $productId) {
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    try {
        const response = await axios.post(
            SHOPIFY_URL,
            { query: mutation, variables: { productId } },
            { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
        //console.log('Raw API Response:', JSON.stringify(response.data, null, 2));
        const result = response.data;

        if (!result || !result.data || !result.data.productDeleteAsync) {
            throw new Error('Invalid response structure from Shopify API');
        }
        
        const userErrors = result.data.productDeleteAsync.userErrors;
        if (userErrors && userErrors.length > 0) {
            const errorMessages = userErrors.map(err => `${err.field}: ${err.message}`).join(', ');
            throw new Error(`Shopify API errors: ${errorMessages}`);
        }


        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
async function deleteProduct(productId) {
    const mutation = `
        mutation productDelete($input: ProductDeleteInput!) {
            productDelete(input: $input) {
                deletedProductId
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    const variables = {
        input: {
            id: productId
        }
    };

    try {
        const response = await axios.post(
            SHOPIFY_URL,
            {
                query: mutation,
                variables: variables
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
                }
            }
        );

        const result = response.data;
        //console.log(response.data);

        if (!result || !result.data || !result.data.productDelete) {
            throw new Error('Invalid response structure from Shopify API');
        }

        const userErrors = result.data.productDelete.userErrors;
        if (userErrors && userErrors.length > 0) {
            const errorMessages = userErrors.map(err => `${err.field}: ${err.message}`).join(', ');
            throw new Error(`Shopify API errors: ${errorMessages}`);
        }

        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function appendLogToFTP(logEntries) {
    const client = new ftp.Client();
    client.ftp.verbose = true;
    let existingLog = [];
  
    const ftpLogFileName = '/In/Plytix/Logs/upload_log.csv'; // Updated remote path
    const logFilePath = path.join(tempDir, 'upload_log.csv');
  
    try {
        await client.access({
            host: "***",
            port: "**",
            user: "****",
            password: "***",
            secure: false
        });

        try {
            const localLogPath = path.join(tempDir, 'upload_log.csv');
            await client.downloadTo(localLogPath, ftpLogFileName); // Updated remote path for download
            const fileContent = fs.readFileSync(localLogPath, 'utf8');
            existingLog = parse(fileContent, { columns: true });
        } catch (err) {
            console.log('No existing log file found. A new log file will be created.');
        }

        const updatedLog = existingLog.concat(logEntries);
        const csvContent = stringify(updatedLog, { header: true }); // Correct usage of stringify
        fs.writeFileSync(logFilePath, csvContent);

        await client.uploadFrom(logFilePath, ftpLogFileName); // Updated remote path for upload
        console.log(`Log file successfully uploaded to ${ftpLogFileName}`);
    } catch (err) {
        console.error('Error handling log file:', err);
    } finally {
        client.close();
    }
}

async function createProductAndVariants(productDetailsArray) {
    const baseProductDetails = productDetailsArray[0];

    // Construct Product Input for GraphQL mutation
    const productInput = {
        title: baseProductDetails["Title"],
        descriptionHtml: baseProductDetails["Body (HTML)"],
        vendor: baseProductDetails["Vendor"],
        productType: baseProductDetails["Type"],
        tags: baseProductDetails["Tags"].split(', '),
        options: [], // Array of option names
        status: "ACTIVE",//baseProductDetails["Status"].toUpperCase(), // Default status
    };

    const mediaInputs = [];

    // Extract option names
    for (let i = 1; i <= 3; i++) {
        const optionNameKey = `Option${i} Name`;
        if (baseProductDetails[optionNameKey]) {
            productInput.options.push(baseProductDetails[optionNameKey]);
        }
    }

    // Variants construction
    const variants = productDetailsArray.map(variantDetails => {

        const variantInput = {
            sku: variantDetails["Variant SKU"],
            barcode: variantDetails["Variant Barcode"],
            taxable: variantDetails["Variant Taxable"]?.toLowerCase() === "true",
            inventoryPolicy: "CONTINUE",//variantDetails["Variant Inventory Policy"]?.toUpperCase() === "CONTINUE" ? "CONTINUE" : "DENY", // Set inventoryPolicy explicitly
            weight: variantDetails["Variant Grams"] ? parseFloat(variantDetails["Variant Grams"]) / 1000 : 0,
            weightUnit: "KILOGRAMS",
            options: [
                variantDetails["Option1 Value"],
                variantDetails["Option2 Value"],
                variantDetails["Option3 Value"]
            ].filter(Boolean),
            inventoryItem: {
                tracked: true // Mark inventory as tracked
            },
            mediaSrc: variantDetails["Variant Image"] ? [variantDetails["Variant Image"]] : undefined // Associate image URL with the variant
        };

        if (variantDetails["Variant Image"]) {
            mediaInputs.push({
                originalSource: variantDetails["Variant Image"],
                mediaContentType: "IMAGE",
                alt: `Image for SKU: ${variantDetails["Variant SKU"]}`
            });
        }

        return variantInput;
    });

    // Attach variants to product input
    productInput.variants = variants;

    try {
        // GraphQL Mutation for creating the product
        const mutation = `
            mutation productCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
                productCreate(input: $input, media: $media) {
                    product {
                        id
                        title
                        status
                        options {
                            id
                            name
                            values
                        }
                        variants(first: 100) {
                            edges {
                                node {
                                    id
                                    sku
                                    title
                                    inventoryPolicy
                                    inventoryItem {
                                        tracked
                                    }
                                    media(first: 10) {
                                        nodes {
                                            id
                                            mediaContentType
                                            preview {
                                                status
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }
        `;

        const variables = {
            input: productInput,
            media: mediaInputs
        };

        // Execute GraphQL mutation
        const response = await axios.post(
            SHOPIFY_URL,
            { query: mutation, variables },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
                }
            }
        );
        //console.log('Raw API Response:', JSON.stringify(response.data, null, 2));
        const result = response.data;

        if (result.errors) {
            return { success: false, error: result.errors };
        }

        const userErrors = result.data.productCreate.userErrors;
        if (userErrors.length > 0) {
            throw new Error(userErrors.map(err => `${err.field}: ${err.message}`).join(', '));
        }
        return { success: true, product: result.data.productCreate.product };
    } catch (error) {
        console.error("Error creating product:", error.message || error);
        return { success: false, error: error.message };
    }
}
async function updateProductAndVariants(productId, productInfo, productData, variantUpdates) {
    const productUpdateMutation = `
        mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
                product {
                    id
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    const variantUpdateMutation = `
        mutation productVariantsBulkUpdate(
            $allowPartialUpdates: Boolean,
            $media: [CreateMediaInput!],
            $productId: ID!,
            $variants: [ProductVariantsBulkInput!]!
        ) {
            productVariantsBulkUpdate(
                allowPartialUpdates: $allowPartialUpdates,
                media: $media,
                productId: $productId,
                variants: $variants
            ) {
                productVariants {
                    id
                    sku
                    media(first: 100) {
                        nodes {
                            id
                            alt
                            mediaContentType
                        }
                    }
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    // Prepare product-level updates
    const productInput = {
        id: productId,
    };

    const csvOptions = [
        productData["Option1 Name"],
        productData["Option2 Name"],
        productData["Option3 Name"],
    ].filter(Boolean);

    if (productData["Vendor"]) productInput.vendor = productData["Vendor"];
    if (productData["Tags"]) productInput.tags = productData["Tags"];
    if (productData["Product Type"]) productInput.productType = productData["Product Type"];
    if (productData["Body (HTML)"]) productInput.bodyHtml = productData["Body (HTML)"];
    if (productData["Status"]) productInput.status = productData["Status"].toUpperCase();
    if (csvOptions.length) productInput.options = csvOptions;

    try {
        // Perform product-level updates only if there are changes
        if (Object.keys(productInput).length > 2) {
            const productResponse = await axios.post(
                SHOPIFY_URL,
                {
                    query: productUpdateMutation,
                    variables: { input: productInput },
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
                    },
                }
            );
            const productResult = productResponse.data;
            if (productResult.data.productUpdate.userErrors.length > 0) {
                throw new Error(
                    productResult.data.productUpdate.userErrors
                        .map((err) => `${err.field}: ${err.message}`)
                        .join(", ")
                );
            }
        } else {
            console.log("No product-level updates to perform.");
        }

        // Prepare variant-level updates
        const updatedVariants = [];
        const productMedia = [];

        for (const row of variantUpdates) {
            const variantToUpdate = productInfo.existingVariants.find((v) => v.sku === row.sku);
            if (!variantToUpdate) {
                console.warn(`Variant with SKU "${row.sku}" not found for product "${productId}".`);
                continue;
            }

            // Delete existing image if a new one is provided
            if (row.image) {
                const deleteImageResult = await deleteMediaBySku(productId, row.sku);
                if (!deleteImageResult.success) {
                    throw new Error(`Failed to delete image for SKU: ${row.sku}, Error: ${deleteImageResult.error}`);
                }
            }

            // Prepare merged variant updates with correct optionValues
            const mergedVariant = {
                id: variantToUpdate.id,
                sku: variantToUpdate.sku,
                optionValues: [
                    { name: row.option1, optionName: productData["Option1 Name"] },
                    { name: row.option2, optionName: productData["Option2 Name"] },
                    { name: row.option3, optionName: productData["Option3 Name"] }
                ].filter(opt => opt.name && opt.optionName), // Ensures valid option values
            };

            if (row.barcode) mergedVariant.barcode = row.barcode;
            if (row.taxable !== undefined) mergedVariant.taxable = row.taxable;
            if (row.inventoryPolicy) mergedVariant.inventoryPolicy = row.inventoryPolicy.toUpperCase();
            if (row.weight) {
                mergedVariant.weight = row.weight;
                mergedVariant.weightUnit = "KILOGRAMS";
            }
            updatedVariants.push(mergedVariant);

            // Add media if there's a new image
            if (row.image) {
                updatedVariants[updatedVariants.length - 1].mediaSrc = [row.image];
                productMedia.push({
                    originalSource: row.image,
                    mediaContentType: "IMAGE",
                    alt: `Image for SKU: ${row.sku}`,
                });
            }
        }

        // Perform variant-level updates only if there are changes
        if (updatedVariants.length > 0) {
            const variantResponse = await axios.post(
                SHOPIFY_URL,
                {
                    query: variantUpdateMutation,
                    variables: {
                        allowPartialUpdates: true,
                        media: productMedia.length > 0 ? productMedia : undefined,
                        productId,
                        variants: updatedVariants,
                    },
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
                    },
                }
            );
            const variantResult = variantResponse.data;
            console.log('Raw API Response:', JSON.stringify(variantResponse.data, null, 2));
            if (variantResult.errors) {
                throw new Error(
                    variantResult.errors.map((err) => `${err.message}`).join(", ")
                );
            }

            if (!variantResult.data.productVariantsBulkUpdate) {
                throw new Error("Missing productVariantsBulkUpdate in the response.");
            }

            if (variantResult.data.productVariantsBulkUpdate.userErrors.length > 0) {
                throw new Error(
                    variantResult.data.productVariantsBulkUpdate.userErrors
                        .map((err) => `${err.field}: ${err.message}`)
                        .join(", ")
                );
            }
        } else {
            console.log("No variant-level updates to perform.");
        }

        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}




async function main() {
    await listFTPFiles();
    const csvRows = await processCSV(localFilePath);
    const logEntries = [];
    const groupedByProduct = groupBy(csvRows, 'Title');

    for (const [title, rows] of Object.entries(groupedByProduct)) {
        const actionsGrouped = groupBy(rows, 'Action');
        for (const key in actionsGrouped) {
            actionsGrouped[key.toLowerCase()] = actionsGrouped[key];
            delete actionsGrouped[key];
        }

        try {
            // Handle Remove Variants
            if (actionsGrouped['remove']) {
                try {
                    const productInfo = await getProductIDByTitle(title);
                    if (!productInfo) {
                        logEntries.push({
                            timestamp: new Date().toISOString(),
                            message: `Product not found for removal`,
                            product: title,
                            error: `ProductInfo is null`,
                        });
                        continue;
                    }

                    const productId = productInfo.productId;
                    const variantIdsToRemove = actionsGrouped['remove'].map(row => {
                        const variantToRemove = productInfo.existingVariants.find(v => v.sku === row['Variant SKU']);
                        if (!variantToRemove) {
                            logEntries.push({
                                timestamp: new Date().toISOString(),
                                message: `Variant not found for removal`,
                                product: title,
                                error: `SKU: ${row['Variant SKU']}`,
                            });
                            return null;
                        }
                        return variantToRemove.id;
                    }).filter(Boolean);

                    if (variantIdsToRemove.length === 0) {
                        logEntries.push({
                            timestamp: new Date().toISOString(),
                            message: `No variants found for removal`,
                            product: title,
                            error: `No matching SKUs in productInfo`,
                        });
                        continue;
                    }

                    let removeResult;
                    if (variantIdsToRemove.length === productInfo.existingVariants.length) {
                        if (variantIdsToRemove.length > 50) {
                            removeResult = await deleteProductAsync(productId);
                            await delay(3000);
                        } else {
                            removeResult = await deleteProduct(productId);
                        }

                        if (!removeResult.success) {
                            logEntries.push({
                                timestamp: new Date().toISOString(),
                                message: `Error deleting product`,
                                product: title,
                                error: removeResult.error,
                            });
                        }
                    } else {
                        removeResult = await deleteVariants(productId, variantIdsToRemove);
                        if (!removeResult.success) {
                            logEntries.push({
                                timestamp: new Date().toISOString(),
                                message: `Error deleting variants`,
                                product: title,
                                error: removeResult.error,
                            });
                        }
                    }
                } catch (error) {
                    logEntries.push({
                        timestamp: new Date().toISOString(),
                        message: `Error in remove action`,
                        product: title,
                        error: error.message,
                    });
                }
            }

            // Handle Update Variants
            if (actionsGrouped['update']) {
                try {
                    const productInfo = await getProductIDByTitle(title);
                    if (!productInfo) {
                        logEntries.push({
                            timestamp: new Date().toISOString(),
                            message: `Product not found for update`,
                            product: title,
                            error: `ProductInfo is null`,
                        });
                        continue;
                    }
                    
                    const productId = productInfo.productId;
                    const productData = actionsGrouped['update'][0];
                    const variantUpdates = actionsGrouped['update'].map(row => {
                        const variantToUpdate = productInfo.existingVariants.find(v => v.sku === row['Variant SKU']);
                        if (!variantToUpdate) {
                            logEntries.push({
                                timestamp: new Date().toISOString(),
                                message: `Variant not found for update`,
                                product: title,
                                error: `SKU: ${row['Variant SKU']}`,
                            });
                            return null;
                        }
                        return {
                            id: variantToUpdate.id,
                            sku: variantToUpdate.sku,
                            barcode: row['Variant Barcode'],
                            taxable: row['Variant Taxable']?.toLowerCase() === 'true',
                            inventoryPolicy: row['Variant Inventory Policy']?.toUpperCase(),
                            weight: row['Variant Grams'] ? parseFloat(row['Variant Grams']) / 1000 : undefined,
                            weightUnit: 'KILOGRAMS',
                            options: [
                                row['Option1 Value'],
                                row['Option2 Value'],
                                row['Option3 Value'],
                            ].filter(Boolean),
                            image: row['Variant Image'],
                        };
                    }).filter(Boolean);

                    const updateResult = await updateProductAndVariants(productId, productInfo, productData, variantUpdates);
                    if (!updateResult.success) {
                        logEntries.push({
                            timestamp: new Date().toISOString(),
                            message: `Error updating product`,
                            product: title,
                            error: updateResult.error,
                        });
                    }
                } catch (error) {
                    logEntries.push({
                        timestamp: new Date().toISOString(),
                        message: `Error in update action`,
                        product: title,
                        error: error.message,
                    });
                }
            }

            // Handle Add Variants
            if (actionsGrouped['add']) {
                try {
                    const productInfo = await getProductIDByTitle(title);
                    if (!productInfo) {
                        console.log("Creating new product");
                        const createResult = await createProductAndVariants(rows);
                        if (!createResult.success) {
                            logEntries.push({
                                timestamp: new Date().toISOString(),
                                message: `Error creating product`,
                                product: title,
                                error: createResult.error,
                            });
                        }
                    } else {
                        const productId = productInfo.productId;
                        const newVariants = actionsGrouped['add'].map(row => ({
                            sku: row['Variant SKU'],
                            barcode: row['Variant Barcode'],
                            taxable: row['Variant Taxable']?.toLowerCase() === 'true',
                            grams: row['Variant Grams'],
                            inventoryPolicy: row['Variant Inventory Policy'],
                            option1: row['Option1 Value'],
                            option2: row['Option2 Value'],
                            option3: row['Option3 Value'],
                            option1name: row['Option1 Name'],
                            option2name: row['Option2 Name'],
                            option3name: row['Option3 Name'],
                            image: row['Variant Image'],
                        }));
                        const addResult = await addVariantsToProduct(productId, newVariants);
                        if (!addResult.success) {
                            logEntries.push({
                                timestamp: new Date().toISOString(),
                                message: `Error adding variants`,
                                product: title,
                                error: addResult.error,
                            });
                        }
                    }
                } catch (error) {
                    logEntries.push({
                        timestamp: new Date().toISOString(),
                        message: `Error in add action`,
                        product: title,
                        error: error.message,
                    });
                }
            }
        } catch (error) {
            logEntries.push({
                timestamp: new Date().toISOString(),
                message: `Error processing product`,
                product: title,
                error: error.message,
            });
        }
    }

    if (logEntries.length > 0) {
        await appendLogToFTP(logEntries);
    }
}


main().catch(console.error);
