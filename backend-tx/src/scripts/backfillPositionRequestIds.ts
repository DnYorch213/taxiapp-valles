import "dotenv/config";
import mongoose from "mongoose";
import { Position } from "../models/Position";

async function main() {
    const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/taxiapp";
    await mongoose.connect(mongoUri);

    const legacyPositions = await Position.find({
        $or: [
            { requestId: { $exists: false } },
            { requestId: null },
            { requestId: "" }
        ]
    }).select("_id email role requestId").lean();

    if (legacyPositions.length === 0) {
        console.log("No se encontraron documentos legacy sin requestId.");
        await mongoose.disconnect();
        return;
    }

    console.log(`Legacy positions a corregir: ${legacyPositions.length}`);

    let updatedCount = 0;
    for (const doc of legacyPositions) {
        const email = String(doc.email || "sin-email").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_");
        const requestId = `legacy_${email}_${String(doc._id)}`;

        const result = await Position.updateOne(
            { _id: doc._id },
            {
                $set: {
                    requestId,
                    updatedAt: new Date(),
                }
            }
        );

        if (result.modifiedCount > 0) {
            updatedCount += 1;
        }
    }

    console.log(`Legacy positions corregidas: ${updatedCount}`);
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error("Error corrigiendo requestId legacy en positions:", error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});