
/* Example in Node.js */
import { readFile, writeFile } from "fs/promises";
import axios from "axios";
import { CMCResponse } from "./cmc-types";

export async function getCmcStats() {
  try {
    return JSON.parse(await readFile("stats.json", "utf-8"));
    let response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
      headers: { 'X-CMC_PRO_API_KEY': process.env.coin_market_cap_key },
    });
    const json = response.data as CMCResponse;
    return json;
    await writeFile("stats.json", JSON.stringify(json, null, "\t"));
    console.log(json);
  } catch (ex) {
    // error
    console.log(ex);
  }
}
