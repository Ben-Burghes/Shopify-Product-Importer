# Shopify FTP Product & Metafield Management

## Overview

This project automates the process of managing products and metafields on a Shopify store by integrating with an FTP server. It downloads product and metafield data, processes updates, and uploads changes to Shopify using the Shopify GraphQL API.

## Features

- **FTP Integration**: Fetches and uploads CSV files from an FTP server.
- **CSV Processing**: Parses and processes CSV files to extract product and metafield data.
- **Shopify Integration**: Uses Shopify's GraphQL API to update products, add/remove variants, and upload metafields.
- **File Splitting**: Splits large CSV files into smaller parts for efficient processing.
- **Logging**: Maintains logs of actions performed and errors encountered.

## Files in the Repository

- `Main.txt`: The core script that processes product data, compares it with the master file, and determines the necessary updates.
- `File Splitter.txt`: Handles splitting large CSV files and re-uploading them to the FTP server.
- `Metafield Upload.txt`: Extracts and uploads metafield data to Shopify.
- `Product Upload.txt`: Adds, updates, and removes products and variants in Shopify.

## Setup & Configuration

### Prerequisites

- Node.js installed
- FTP credentials for accessing the server
- Shopify API access with necessary permissions

### Configuration

Update the following variables in the scripts:

- **FTP Credentials** (host, user, password)
- **Shopify API Credentials** (Shopify store URL and access token)
- **File Paths** (CSV file locations on FTP and local temp storage)

### Installation

1. Clone the repository
2. Install dependencies:
   ```sh
   npm install basic-ftp csv-parser axios csv-parse csv-stringify promise-ftp
   ```
3. Configure the necessary credentials and file paths.

### Running the Scripts

Run individual scripts based on the required task:

- **Process product updates:**
  ```sh
  node Main.txt
  ```
- **Split large CSV files:**
  ```sh
  node File Splitter.txt
  ```
- **Upload metafields to Shopify:**
  ```sh
  node Metafield Upload.txt
  ```
- **Upload product changes to Shopify:**
  ```sh
  node Product Upload.txt
  ```

## How It Works

1. **File Download:** The scripts download necessary CSV files from the FTP server.
2. **Data Processing:** The CSV files are parsed, and product or metafield changes are identified.
3. **Shopify API Requests:** The scripts make API calls to add, update, or delete products and metafields.
4. **File Upload & Logging:** Processed files and logs are uploaded back to the FTP server for tracking.

## Logs & Debugging

- Logs are stored in `/In/Plytix/Logs/` on the FTP server.
- Check console output for errors and debugging messages.
- Ensure proper API permissions are granted if encountering authentication issues.

## Future Enhancements

- Add retry mechanisms for failed FTP operations.
- Implement better error handling and reporting.
- Optimize API calls for bulk operations.

## License

This project is proprietary and should not be shared without permission.

