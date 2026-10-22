import { Float, OrbitControls, Sparkles } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useRef } from "react";
import type { Group } from "three";
function OrbitalCore() {
  const group = useRef<Group>(null);
  useFrame((state, delta) => {
    if (group.current) {
      group.current.rotation.y += delta * 0.12;
      group.current.rotation.x =
        Math.sin(state.clock.elapsedTime * 0.24) * 0.08;
    }
  });
  return (
    <group ref={group}>
      <mesh>
        <icosahedronGeometry args={[1.45, 3]} />
        <meshStandardMaterial
          color="#06131b"
          emissive="#0ec5df"
          emissiveIntensity={0.28}
          roughness={0.28}
          metalness={0.82}
          wireframe
        />
      </mesh>
      {[1.85, 2.18, 2.5].map((radius, index) => (
        <mesh
          key={radius}
          rotation={[index * 0.68, index * 0.32, index * 1.08]}
        >
          <torusGeometry args={[radius, 0.012, 12, 110]} />
          <meshBasicMaterial
            color={index === 1 ? "#f6a84b" : "#51d9ed"}
            transparent
            opacity={0.52 - index * 0.1}
          />
        </mesh>
      ))}
      <Sparkles count={58} scale={5.4} size={2.2} speed={0.2} color="#8ae7f5" />
    </group>
  );
}

export default function OrbitalScene() {
  return (
    <Canvas camera={{ position: [0, 0, 6.8], fov: 42 }} dpr={[1, 1.5]}>
      <ambientLight intensity={0.5} />
      <pointLight position={[4, 3, 4]} color="#48d9ef" intensity={18} />
      <pointLight position={[-4, -2, 3]} color="#ff9f43" intensity={10} />
      <Suspense fallback={null}>
        <Float speed={1.2} rotationIntensity={0.25} floatIntensity={0.35}>
          <OrbitalCore />
        </Float>
      </Suspense>
      <OrbitControls
        enableZoom={false}
        enablePan={false}
        autoRotate
        autoRotateSpeed={0.35}
      />
    </Canvas>
  );
}
