@echo off
echo Installing backend dependencies...
cd backend
pip install -r requirements.txt
echo.
echo Starting backend server...
start cmd /k "uvicorn main:app --reload --port 8000"
cd ..\frontend
echo Starting frontend...
start cmd /k "npm start"
echo.
echo Both servers are starting!
echo Backend: http://localhost:8000
echo Frontend: http://localhost:3000
