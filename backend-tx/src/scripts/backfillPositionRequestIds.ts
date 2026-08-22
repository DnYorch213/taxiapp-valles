import "dotenv/config";
import mongoose from "mongoose";
import { Position } from "../models/Position";

async function main() {
    const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/taxiapp";

    console.log("🔌 Conectando a MongoDB...");
    await mongoose.connect(mongoUri);

    // Buscar documentos que carezcan de requestId válido
    const legacyPositions = await Position.find({
        $or: [
            { requestId: { $exists: false } },
            { requestId: null },
            { requestId: "" }
        ]
    }).select("_id email").lean();

    if (legacyPositions.length === 0) {
        console.log("✅ No se encontraron documentos legacy sin requestId.");
        return;
    }

    console.log(`🔍 Legacy positions a corregir: ${legacyPositions.length}`);

    // Construir operaciones masivas para bulkWrite (Evita el patrón N+1)
    const bulkOps = legacyPositions.map((doc) => {
        const email = String(doc.email || "sin-email")
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "_");

        const requestId = `legacy_${email}_${String(doc._id)}`;

        return {
            updateOne: {
                filter: { _id: doc._id },
                update: {
                    $set: {
                        requestId,
                        updatedAt: new Date(),
                    }
                }
            }
        };
    });

    // Ejecutar todas las actualizaciones en una sola transacción/petición
    const result = await Position.bulkWrite(bulkOps);

    console.log(`🎉 Legacy positions corregidas exitosamente: ${result.modifiedCount}`);
}

main()
    .then(async () => {
        await mongoose.disconnect();
        console.log("👋 Conexión a MongoDB cerrada limpiamente.");
        process.exit(0);
    })
    .catch(async (error) => {
        console.error("❌ Error corrigiendo requestId legacy en positions:", error);
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
        process.exit(1);
    });