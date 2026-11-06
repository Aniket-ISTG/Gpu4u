export default function AmbientBackground() {
  return (
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        {/* Subtle architectural square grid */}
        <div className="absolute inset-0 square-grid opacity-70" />
        
        {/* Top ambient warm cream beige wash */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1100px] h-[450px] bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,rgba(232,210,181,0.22),transparent_75%)] blur-2xl" />
        
        {/* Flank atmospheric muted sage grey wash */}
        <div className="absolute top-[20%] -left-[100px] w-[600px] h-[600px] bg-[radial-gradient(circle,rgba(165,167,155,0.18),transparent_65%)] blur-3xl" />
        
        {/* Core deep navy bloom */}
        <div className="absolute top-[35%] -right-[100px] w-[700px] h-[700px] bg-[radial-gradient(circle,rgba(25,55,97,0.55),transparent_70%)] blur-3xl" />
      </div>
  );
}
