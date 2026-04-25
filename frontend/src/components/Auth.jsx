import { useState } from "react";
import { supabase } from "../supabase";

export default function Auth({ onLogin }) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAuth = async () => {
  if (loading) return; // 🔥 GUARD (prevents spam clicks)

  setLoading(true);

  if (isLogin) {
    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        alert(error.message);
      } else {
        onLogin(data.session);
      }
    } else {
      const { error } = await supabase.auth.signUp({
        email,
        password,
      });

      if (error) {
        alert(error.message);
      } else {
        alert("Signup successful. Now login.");
        setIsLogin(true);
      }
    }

    setLoading(false);
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h2 style={styles.title}>
          {isLogin ? "Welcome Back 👋" : "Create Account 🚀"}
        </h2>

        <p style={styles.subtitle}>
          {isLogin
            ? "Login to continue"
            : "Sign up to start exploring papers"}
        </p>

        <input
          style={styles.input}
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          style={styles.input}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button style={styles.button} onClick={handleAuth} disabled={loading}>
          {loading
            ? "Please wait..."
            : isLogin
            ? "Login"
            : "Sign Up"}
        </button>

        <p style={styles.switch}>
          {isLogin ? "New here?" : "Already have an account?"}
          <span
            style={styles.link}
            onClick={() => setIsLogin(!isLogin)}
          >
            {isLogin ? " Sign Up" : " Login"}
          </span>
        </p>
      </div>
    </div>
  );
}

// 🎨 Styles (simple but clean)
const styles = {
  container: {
    height: "100vh",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    background: "#f5f7fa",
  },
  card: {
    width: "350px",
    padding: "30px",
    borderRadius: "12px",
    background: "#ffffff",
    boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
    textAlign: "center",
  },
  title: {
    marginBottom: "10px",
  },
  subtitle: {
    fontSize: "14px",
    color: "#666",
    marginBottom: "20px",
  },
  input: {
    width: "100%",
    padding: "10px",
    marginBottom: "15px",
    borderRadius: "8px",
    border: "1px solid #ddd",
    fontSize: "14px",
  },
  button: {
    width: "100%",
    padding: "12px",
    borderRadius: "8px",
    border: "none",
    background: "#4f46e5",
    color: "#fff",
    fontSize: "16px",
    cursor: "pointer",
  },
  switch: {
    marginTop: "15px",
    fontSize: "14px",
  },
  link: {
    color: "#4f46e5",
    cursor: "pointer",
    fontWeight: "bold",
  },
};