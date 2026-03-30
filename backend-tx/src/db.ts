import mongoose from "mongoose";

export const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/taxiapp";

    const conn = await mongoose.connect(mongoURI);

    // 💡 Esto te imprimirá exactamente a qué base de datos se conectó (ej. taxiapp)
    console.log(`✅ Conectado a MongoDB: ${conn.connection.name.toUpperCase()}`);

  } catch (err) {
    console.error("❌ Error al conectar a MongoDB:", err);
    process.exit(1);
  }
};