const PromiseFtp = require('promise-ftp');
const csv = require('csv-parser');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const fs = require('fs');
const path = require('path');

const ftp = new PromiseFtp();

async function downloadFile(ftpClient, remotePath, localPath) {
    return new Promise((resolve, reject) => {
        ftpClient.get(remotePath, (err, stream) => {
            if (err) return reject(err);
            stream.once('close', () => resolve(localPath));
            stream.pipe(fs.createWriteStream(localPath));
        });
    });
}

async function processCSV(filePath) {
    const results = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', reject);
    });
}

function compareCSV(plytixFeed, masterFeed) {
    const combined = [];
    const plytixMap = new Map();

    // Create a map for the plytix feed using 'Variant SKU' as the key
    plytixFeed.forEach(row => {
        plytixMap.set(row['Variant SKU'], row);
    });

    // Compare master_feed with plytix_feed
    masterFeed.forEach(masterRow => {
        const plytixRow = plytixMap.get(masterRow['Variant SKU']);
        
        if (!plytixRow) {
            // SKU exists in the master file but not in the plytix feed (product to be removed)
            combined.push({
                ...masterRow,
                Action: 'Remove'
            });
        } else {
            // Check if the number of option names does not match
            const masterOptions = ['Option1 Name', 'Option2 Name', 'Option3 Name'].filter(option => masterRow[option]);
            const plytixOptions = ['Option1 Name', 'Option2 Name', 'Option3 Name'].filter(option => plytixRow[option]);

            if (masterOptions.length !== plytixOptions.length) {
                // Number of option names does not match, mark for removal and creation
                combined.push({
                    ...masterRow,
                    Action: 'Remove'
                });
                combined.push({
                    ...plytixRow,
                    Action: 'Add'
                });
            } else if (plytixRow['Handle'] !== masterRow['Handle']) {
                // SKU exists in both feeds but with a different handle (remove old, add new)
                combined.push({
                    ...masterRow,
                    Action: 'Remove'
                });
                combined.push({
                    ...plytixRow,
                    Action: 'Add'
                });
            } else {
                // Keep specific fields, including options
                const modifiedRow = {
                    'Variant SKU': plytixRow['Variant SKU'],
                    'Handle': plytixRow['Handle'] || '',
                    'Title': plytixRow['Title'] || '',
                    'Option1 Name': plytixRow['Option1 Name'] || '',
                    'Option1 Value': plytixRow['Option1 Value'] || '',
                    'Option2 Name': plytixRow['Option2 Name'] || '',
                    'Option2 Value': plytixRow['Option2 Value'] || '',
                    'Option3 Name': plytixRow['Option3 Name'] || '',
                    'Option3 Value': plytixRow['Option3 Value'] || '',
                    Action: 'Update'
                };
                let modified = false;

                // Check for changes in Option Names and Values
                ['Option1 Name', 'Option2 Name', 'Option3 Name', 'Option1 Value', 'Option2 Value', 'Option3 Value'].forEach(optionField => {
                    if (plytixRow[optionField] !== masterRow[optionField]) {
                        // If the value is different, update it
                        modifiedRow[optionField] = plytixRow[optionField];
                        modified = true;
                    }
                });

                // Check for modifications in other fields
                Object.keys(plytixRow).forEach(key => {
                    if (![
                        'Variant SKU',
                        'Handle',
                        'Title',
                        'Option1 Name',
                        'Option1 Value',
                        'Option2 Name',
                        'Option2 Value',
                        'Option3 Name',
                        'Option3 Value'
                    ].includes(key)) {
                        if (plytixRow[key] !== masterRow[key]) {
                            // If the value is different, keep it
                            modifiedRow[key] = plytixRow[key];
                            modified = true;
                        } else {
                            // If the value is the same, make it an empty string
                            modifiedRow[key] = '';
                        }
                    }
                });

                if (modified) {
                    // Only add the row if there is any modification
                    combined.push(modifiedRow);
                }
            }
        }
    });

    // Identify new products in plytix_feed that are not in the master_feed
    plytixFeed.forEach(plytixRow => {
        const matchingMasterRows = masterFeed.filter(masterRow => masterRow['Handle'] === plytixRow['Handle']);

        if (!matchingMasterRows.length) {
            // New product to be created
            combined.push({
                ...plytixRow,
                Action: 'Add'
            });
        } else {
            // There is a matching product, but check for new variants
            const existingVariant = matchingMasterRows.find(masterRow => masterRow['Variant SKU'] === plytixRow['Variant SKU']);
            if (!existingVariant) {
                // New variant with the same handle but a different SKU
                combined.push({
                    ...plytixRow,
                    Action: 'Add'
                });
            }
        }
    });

    // Remove duplicate rows from combined
    return removeDuplicates(combined);
}

// Function to remove duplicate rows from the array based on 'Handle', 'Variant SKU', and 'Action'
function removeDuplicates(data) {
    const uniqueRows = new Map();

    data.forEach(row => {
        const uniqueKey = `${row['Handle']}_${row['Variant SKU']}_${row['Action']}`;
        if (!uniqueRows.has(uniqueKey)) {
            uniqueRows.set(uniqueKey, row);
        }
    });

    return Array.from(uniqueRows.values());
}


// Function to sort data by 'Handle'
function sortByHandle(data) {
    return data.sort((a, b) => {
        const handleA = a['Handle']?.toLowerCase() || '';
        const handleB = b['Handle']?.toLowerCase() || '';
        if (handleA < handleB) return -1;
        if (handleA > handleB) return 1;
        return 0;
    });
}

async function uploadFile(ftpClient, localFilePath, remoteFilePath) {
    return ftpClient.put(localFilePath, remoteFilePath);
}
function filterColumns(combinedData, columnList, requiredNonEmptyColumns) {
    return combinedData
        .map(row => {
            const filteredRow = {};
            
            // Include only the columns from columnList
            columnList.forEach(column => {
                if (row.hasOwnProperty(column)) {
                    filteredRow[column] = row[column]?.toString().trim() || ''; // Ensure values are strings
                }
            });

            // Check if the row contains non-empty values outside required fields
            const hasNonRequiredValues = columnList
                .filter(column => !requiredNonEmptyColumns.includes(column))
                .some(column => filteredRow[column] && filteredRow[column] !== '');

            // Exclude rows with only required fields filled
            if (!hasNonRequiredValues) {
                return null;
            }

            return filteredRow;
        })
        .filter(Boolean); // Remove null rows
}

const metafieldColumns = [
    "Variant SKU",
    "Handle",
    "Title",
    "SEO Title",
    "SEO Description",
    "product_colour",
    "primary_colour",
    "primary_colour_hex_code",
    "secondary_colour",
    "secondary_colour_hex_code",
    "Material",
    "Base/Frame Material",
    "chair_base_material",
    "fire_retardant_level",
    "Component Guarantee",
    "Upholstery Guarantee",
    "usage_recommended_in_hours",
    "weight_tolerance_text_value",
    "desk_top_thickness_mm",
    "side_panel_thickness_mm",
    "back_panel_thickness_mm",
    "modesty_panel_thickness_mm",
    "cable_port_diameter_mm",
    "steel_leg_thickness_mm",
    "steel_tube_profile_mm",
    "quantity_of_drawers",
    "quantity_of_shelves",
    "shelf_width_mm",
    "shelf_depth_mm",
    "shelf_thickness_mm",
    "gross_package_weight_kg",
    "nett_weight_kg",
    "package_volume_m³",
    "effective_volume_m³",
    "package_width_mm",
    "package_depth_mm",
    "package_height_mm",
    "product_width_mm",
    "product_depth_mm",
    "product_height_minimum_mm",
    "product_height_maximum_mm",
    "seat_height_minimum_mm",
    "seat_height_maximum_mm",
    "Seat_Pad_Thickness_mm",
    "seat_pad_width_mm",
    "seat_pad_depth_mm",
    "Seat_Back_Thickness_mm",
    "seat_back_height_mm",
    "seat_back_width_mm",
    "Mechanism Locking Positions",
    "Mechanism Type",
    "Anti Tilt Mechanism (Y/N)",
    "Arm Type",
    "arm_height_from_seat_pad_minimum_mm",
    "arm_height_from_seat_pad_maximum_mm",
    "arm_height_from_floor_minimum_mm",
    "arm_height_from_floor_maximum_mm",
    "arm_height_as_a_component_minimum_mm",
    "arm_height_as_a_component_maximum_mm",
    "seat_slide_adjustment_mm",
    "Gas Lift Colour",
    "gas_lift_size_mm",
    "castor_size_mm",
    "Foot Type",
    "foot_adjustment_mm",
    "chair_base_diameter_mm",
    "stacking_quantity",
    "ISPC 2 Description",
    "ISPC 2",
    "overall_dimensions",
    "Product Family",
    "Sub-Family",
    "unlimited",
    "Classification",
    "Shopify Filter Category"
];

const productColumns = [
    "Variant SKU",
    "Handle",
    "Title",
    "Option1 Name",
    "Option1 Value",
    "Option2 Name",
    "Option2 Value",
    "Option3 Name",
    "Option3 Value",
    "Action",
    "Body (HTML)",
    "Vendor",
    "Product Category",
    "Type",
    "Tags",
    "Variant Grams",
    "Variant Barcode",
    "Variant Inventory Policy",
    "Variant Fulfillment Service",
    "Variant Taxable",
    //"Image Alt Text",
    "Variant Image",
    "Variant Weight Unit",
    "Status",
];

const metafieldColumnsRequired = [
    "Variant SKU",
    "Handle",
    "Title"];
const productColumnsRequired = [
    "Variant SKU",
    "Handle",
    "Title",
    "Option1 Name",
    "Option1 Value",
    "Option2 Name",
    "Option2 Value",
    "Option3 Name",
    "Option3 Value",
    "Action",
    "Variant Grams"];

async function main() {
    const ftpConfig = {
        host: '****',
        user: '****',
        password: '***',
    };

    // Local paths for downloaded CSV files
    const localPlytixFeed = path.join(__dirname, 'plytix_feed.csv');
    const localMasterPlytixFeed = path.join(__dirname, 'MASTER_plytix_feed.csv');
    const localProductCSV = path.join(__dirname, 'product_for_upload.csv');
    const localMetafieldCSV = path.join(__dirname, 'metafield_for_upload.csv');

    try {
        // Connect to FTP server
        await ftp.connect(ftpConfig);
        console.log('Connected to FTP server');

        // Download the CSV files from Plytix/In
        await downloadFile(ftp, '/In/Plytix/plytix_feed.csv', localPlytixFeed);
        await downloadFile(ftp, '/In/Plytix/MASTER_plytix_feed.csv', localMasterPlytixFeed);

        // Process the CSV files
        const plytixFeed = await processCSV(localPlytixFeed);
        const masterFeed = await processCSV(localMasterPlytixFeed);

        // Compare and find differences
        const combinedData = compareCSV(plytixFeed, masterFeed);
        console.log('Total products for action:', combinedData.length);
      
        const metafieldData = filterColumns(combinedData,metafieldColumns,metafieldColumnsRequired);
        const productData = filterColumns(combinedData,productColumns,productColumnsRequired);
      
        // Sort combined data by 'Handle'
        const sortedMetafieldData = sortByHandle(metafieldData);
        const sortedProductData = sortByHandle(productData);

        // Create a new CSV for combined data
        if (sortedMetafieldData.length > 0) {
            const csvMetafieldContent = stringify(sortedMetafieldData, { header: true });
            fs.writeFileSync(localMetafieldCSV, csvMetafieldContent);
            console.log('Created CSV for Metafields with actions.');

            // Upload the combined CSV back to Plytix/In on the FTP server
            await uploadFile(ftp, localMetafieldCSV, '/In/Plytix/Upload/metafield_for_upload.csv');
            console.log('Uploaded CSV with Metafields for actions to FTP.');
        } else {
            console.log('No Metafields for actions found.');
        }
        if (sortedProductData.length > 0) {
            const csvProductContent = stringify(sortedProductData, { header: true });
            fs.writeFileSync(localProductCSV, csvProductContent);
            console.log('Created CSV for products with actions.');

            // Upload the combined CSV back to Plytix/In on the FTP server
            await uploadFile(ftp, localProductCSV, '/In/Plytix/Upload/product_for_upload.csv');
            console.log('Uploaded CSV with products for actions to FTP.');
        } else {
            console.log('No products for actions found.');
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        ftp.end();
        console.log('FTP connection closed.');
    }
}

main().catch(console.error);
