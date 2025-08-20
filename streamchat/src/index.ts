import cors from "cors";
import "dotenv/config";
import express from "express";

const app = express()

app.use(express.json());
app.use(cors({origin: "*"}));

app.get("/", (req, res) =>{
    res.json({
        message: "AI Writing Assistant Server is up and running"
    });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
    console.log(`The Server is running at http://localhost:${port}`)
})