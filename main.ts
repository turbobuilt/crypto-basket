import ccxt from "ccxt"
import { getCmcStats } from "./coinmarketcap";
import { readFile } from "fs/promises";
import { writeFileSync } from "fs";

(async function () {
    let maxCurrencies = 10;
    // let stats = await getCmcStats();
    let stats = JSON.parse(await readFile("cmc.json", "utf-8"));
    
    let coinbaseadvanced = new ccxt.coinbaseadvanced({
        apiKey: process.env.coinbase_key_name,
        secret: process.env.coinbase_key?.replace(/\\n/g, '\n'),
    });

    let markets = await coinbaseadvanced.loadMarkets ();
    let pairs = Object.keys(markets); 

    // set sanbox
    let portfolios = await coinbaseadvanced.fetchPortfolios();
    coinbaseadvanced.options.portfolio = portfolios[0].id;
    

    // now get the coins we currently own
    let coins = await coinbaseadvanced.fetchAccounts({ paginate: true, limit: 250 })
    let positions: { symbol: string, amount: number, usdValue: number }[] = [];
    await Promise.all(coins.map(async (coin) => {
        if (coin.type !== "wallet") return;
        if (coin.info.available_balance.value == 0) return;
        if (coin.code === "USD") return;

        let ticker = await coinbaseadvanced.fetchTicker(coin.code + "/USD");
        if (!ticker.last) {
            throw new Error("No ticker found for " + coin.code);
        }
        positions.push({
            symbol: coin.code as string,
            amount: coin.info.available_balance.value,
            usdValue: coin.info.available_balance.value * ticker.last,
        });
    }));
    positions = positions.filter((position) => position.usdValue > .01);
    writeFileSync("coins.json", JSON.stringify(coins, null, 2));

    let trades: { symbol: string, amount: number, action: "buy"|"sell", usdValue: number }[] = [];

    // 1. Extract top 10 by market cap
    let excludedCoins = ["USDC","USDT"];
    let topCoins = stats.data
        .sort((a: any, b: any) => b.quote.USD.market_cap - a.quote.USD.market_cap)
        // make sure the coin+"/USD" pair exists
        .filter((c: any) => pairs.includes(c.symbol + "/USD") && !excludedCoins.includes(c.symbol))
        .slice(0, 10)
        .map((c: any) => c.symbol);

    // 2. Identify non-top-10 positions to sell
    positions.forEach(pos => {
        if (!topCoins.includes(pos.symbol)) {
            trades.push({ symbol: pos.symbol, amount: pos.amount, usdValue: pos.usdValue, action: "sell" });
        }
    });

    // 3. Compute total and average
    let totalValue = positions.reduce((sum, p) => sum + p.usdValue, 0);
    let averageValue = totalValue / positions.length;

    // 4. Sell excess above 10% of total
    for (let pos of positions) {
        if (pos.usdValue > averageValue && positions.length === maxCurrencies) {
            let excessUsd = pos.usdValue - averageValue;
            let ticker = await coinbaseadvanced.fetchTicker(pos.symbol + "/USD");
            if (!ticker.last) {
                throw new Error("No ticker found for " + pos.symbol);
            }
            let excessCoins = excessUsd / ticker.last;
            trades.push({ symbol: pos.symbol, amount: excessCoins, usdValue: excessUsd, action: "sell" });
        }
    }

    for(let trade of trades) {
        console.log(trade.action, trade.amount, trade.symbol, "for", trade.usdValue, "USD");
        // let result = await coinbaseadvanced.createOrder(trade.symbol + "/USD", "market", trade.action, trade.amount);
        // console.log(result);
        // writeFileSync("trade.json", JSON.stringify(result, null, 2));
    }
    trades.length = 0;
    // wait for all orders to complete
    for (var i = 0; i < 1000; ++i) {
        let orders = await coinbaseadvanced.fetchOrders();
        if (orders.length === 0) break;
        let openOrders = orders.filter(o => o.status === "OPEN");
        if (openOrders.length === 0) break;

        console.log("Waiting for orders to complete...");
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 5. Check available USD
    // let usdPos = positions.find(p => p.symbol === "USD");
    // fetch usd pos
    let accounts = await coinbaseadvanced.fetchAccountsV3()
    let usdPos = accounts.find(a => a.code === "USD");
    let usdBalance = parseFloat(usdPos?.info.available_balance.value);
    console.log("USD balance", usdBalance);
    if (!usdBalance) {
        throw new Error("No USD balance found");
    }
    let newCoins = topCoins.filter(symbol => !positions.some(p => p.symbol === symbol));
    console.log("newCoins", newCoins)
    let perPosFunds = usdBalance / newCoins.length;
    let buyBudget = perPosFunds; //Math.min(perPosFunds, averageValue);
    console.log("buyBudget", buyBudget, "perPosFunds", perPosFunds, "averageValue", averageValue);

    // 6. Buy new positions with allocated budget
    for (let sym of newCoins) {
        if (buyBudget <= 0) break;
        let ticker = await coinbaseadvanced.fetchTicker(sym + "/USD");
        if (!ticker.last) {
            throw new Error("No ticker found for " + sym);
        }
        let amt = buyBudget / ticker.last;
        trades.push({ symbol: sym, amount: amt, usdValue: buyBudget, action: "buy" });
    }

    // 7. Top up below-average positions
    for (let pos of positions) {
        if (topCoins.includes(pos.symbol)) {
            let lowerBound = averageValue * 0.9;
            if (pos.usdValue < lowerBound) {
                let neededUsd = averageValue - pos.usdValue;
                if (neededUsd > 0 && neededUsd <= usdBalance) {
                    let ticker = await coinbaseadvanced.fetchTicker(pos.symbol + "/USD");
                    if (!ticker.last) {
                        throw new Error("No ticker found for " + pos.symbol);
                    }
                    let neededCoins = neededUsd / ticker.last;
                    trades.push({ symbol: pos.symbol, amount: neededCoins, usdValue: neededUsd, action: "buy" });
                    usdBalance -= neededUsd;
                }
            }
        }
    }
    for (let trade of trades) {
        // console.log(trade.action, trade.amount, trade.symbol, "for", trade.usdValue, "USD");
        if (trade.action === "buy") {
            trade.amount *= .99;
        }
        console.log(trade.action, trade.amount, trade.symbol, "for", trade.usdValue, "USD");
        // coinbaseadvanced.createOrder(trade.symbol + "/USD", "market", trade.action, trade.amount);
    }
    console.log("Trades to execute:", trades);
}) ();