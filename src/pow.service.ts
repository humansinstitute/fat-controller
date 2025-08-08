import { getEventHash } from "nostr-tools";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { fileURLToPath } from 'url';

/**
 * Mines a Nostr event for NIP-13 proof-of-work.
 * @param {NDKEvent} evt - The signed event to mine.
 * @param {number} difficulty - Required leading zero bits.
 * @returns {Promise<Object>} - The mined raw event data.
 */
export function mineEventPow(evtOrRaw: NDKEvent | any, difficulty: number = 20): Promise<any> {
    const serialized = typeof evtOrRaw.rawEvent === 'function'
        ? evtOrRaw.rawEvent()
        : evtOrRaw;
    
    return new Promise((resolve, reject) => {
        const __filename = fileURLToPath(import.meta.url);
        const worker = new Worker(__filename, {
            workerData: { serialised: serialized, difficulty }
        });
        worker.once("message", (mined) => resolve(mined));
        worker.once("error", reject);
    });
}

if (!isMainThread && parentPort) {
    const { serialised, difficulty } = workerData;
    let nonce = 0;
    let mined = { ...serialised };

    function hashMatchesDifficulty(id: string, bits: number): boolean {
        const requiredHexZeros = Math.floor(bits / 4);
        if (!id.startsWith("0".repeat(requiredHexZeros))) return false;
        if (bits % 4 === 0) return true;
        const nibble = parseInt(id[requiredHexZeros], 16);
        const remainingBits = bits % 4;
        return (nibble >> (4 - remainingBits)) === 0;
    }

    while (true) {
        mined.tags = [
            ...(serialised.tags || []),
            ["nonce", nonce.toString(), difficulty.toString()]
        ];
        mined.id = getEventHash(mined);
        if (hashMatchesDifficulty(mined.id, difficulty)) break;
        nonce++;
    }

    parentPort.postMessage(mined);
}