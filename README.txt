REAL-TIME GROUP CHAT - MONGODB VERSION

1. Copy these files into your existing project folder (keep a backup first).
2. In PowerShell, open the project folder and run: npm install
3. Copy .env.example to a new file named .env.
4. Put your MongoDB Atlas connection string in MONGODB_URI in .env.
5. Run: npm start
6. Open http://localhost:3000

Do not upload .env or share its connection string. Configure the same MONGODB_URI as an environment variable in Render when deploying.

This version stores groups and messages in MongoDB. Message history loads when a member opens a group (latest 100 messages). Browser membership is identified by a client-generated ID in localStorage; this is a learning-project identity mechanism, not secure account authentication.
