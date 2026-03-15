// db.ts
import mongoose from "mongoose";

export const connectDB = async () => {
  try {
    // 💡 Usamos process.env.MONGO_URI si existe, de lo contrario usa el local
    const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/taxiapp";

    await mongoose.connect(mongoURI);
    console.log("✅ Conectado a MongoDB (Atlas o Local)");
  } catch (err) {
    console.error("❌ Error al conectar a MongoDB:", err);
    process.exit(1);
  }
};