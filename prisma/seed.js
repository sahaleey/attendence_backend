import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

import P from "../src/permissions/permission.constants.js";
import ROLE_PERMISSIONS from "../src/permissions/permission-map.js";
import { labelOf } from "../src/permissions/permission-catalog.js";
import { seedDemo } from "./seed-demo.js";

const db = new PrismaClient({
  log: ["error", "warn"],
});

// Configuration
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const WITH_DEMO = process.argv.includes("--demo") || process.env.SEED_DEMO === "true";
const STEPS = WITH_DEMO ? 4 : 3;

async function seedPermissions() {
  console.log(`\n[1/${STEPS}] Seeding permissions...`);

  const permissionNames = [...new Set(Object.values(P))];

  if (permissionNames.length === 0) {
    console.log("No permissions found.");
    return {};
  }

  // Insert missing permissions in one database operation.
  await db.permission.createMany({
    data: permissionNames.map((name) => ({
      name,
      description: labelOf(name),
    })),
    skipDuplicates: true,
  });

  // Fetch all permissions and build name -> ID mapping.
  const permissions = await db.permission.findMany({
    where: {
      name: { in: permissionNames },
    },
    select: {
      id: true,
      name: true,
    },
  });

  const permissionMap = Object.fromEntries(
    permissions.map(({ name, id }) => [name, id])
  );

  const missingPermissions = permissionNames.filter(
    (name) => !permissionMap[name]
  );

  if (missingPermissions.length > 0) {
    throw new Error(
      `Missing permissions: ${missingPermissions.join(", ")}`
    );
  }

  console.log(`   ✓ ${permissions.length} permissions ready.`);

  return permissionMap;
}

async function seedRoles(permissionMap) {
  console.log(`\n[2/${STEPS}] Seeding roles...`);

  const roleEntries = Object.entries(ROLE_PERMISSIONS);

  for (const [roleName, permissionNames] of roleEntries) {
    const unknownPermissions = permissionNames.filter(
      (name) => !permissionMap[name]
    );

    if (unknownPermissions.length > 0) {
      throw new Error(
        `Role "${roleName}" references unknown permissions: ${
          unknownPermissions.join(", ")
        }`
      );
    }
  }

  // Create missing roles without overwriting existing descriptions.
  await db.role.createMany({
    data: roleEntries.map(([name]) => ({
      name,
      description: `${name} role`,
    })),
    skipDuplicates: true,
  });

  const roles = await db.role.findMany({
    where: {
      name: { in: roleEntries.map(([name]) => name) },
    },
    select: {
      id: true,
      name: true,
    },
  });

  const roleMap = Object.fromEntries(
    roles.map(({ name, id }) => [name, id])
  );

  // Create only missing role-permission relationships.
  // Existing relationships are preserved.
  const rolePermissionData = roleEntries.flatMap(
    ([roleName, permissionNames]) =>
      permissionNames.map((permissionName) => ({
        roleId: roleMap[roleName],
        permissionId: permissionMap[permissionName],
      }))
  );

  if (rolePermissionData.length > 0) {
    await db.rolePermission.createMany({
      data: rolePermissionData,
      skipDuplicates: true,
    });
  }

  console.log(`   ✓ ${roles.length} roles ready.`);
  console.log(
    `   ✓ ${rolePermissionData.length} role-permission mappings ensured.`
  );

  return roleMap;
}

async function seedAdmin(roleMap) {
  console.log(`\n[3/${STEPS}] Seeding administrator...`);

  if (!ADMIN_PASSWORD) {
    throw new Error(
      "SEED_ADMIN_PASSWORD is missing from your .env file. " +
      "Set a strong password before running the seed."
    );
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const admin = await db.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {
      isActive: true,
    },
    create: {
      name: "System Administrator",
      email: ADMIN_EMAIL,
      passwordHash,
    },
  });

  const adminRoleId = roleMap.ADMIN;

  if (!adminRoleId) {
    throw new Error(
      'ADMIN role was not found. Ensure ROLE_PERMISSIONS contains "ADMIN".'
    );
  }

  await db.userRole.upsert({
    where: {
      userId_roleId: {
        userId: admin.id,
        roleId: adminRoleId,
      },
    },
    create: {
      userId: admin.id,
      roleId: adminRoleId,
    },
    update: {},
  });

  console.log(`   ✓ Administrator ready: ${ADMIN_EMAIL}`);
}

async function main() {
  const startedAt = Date.now();

  console.log("========================================");
  console.log("       ATTENDANCE DATABASE SEED");
  console.log("========================================");

  console.log("\nChecking database connection...");

  await db.$connect();

  console.log("✓ Database connected.");

  const permissionMap = await seedPermissions();
  const roleMap = await seedRoles(permissionMap);

  await seedAdmin(roleMap);

  if (WITH_DEMO) {
    console.log(`\n[4/${STEPS}] Seeding demo school data...`);
    await seedDemo(db, roleMap);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

  console.log("\n========================================");
  console.log("       ✓ SEED COMPLETED SUCCESSFULLY");
  console.log(`       Time: ${elapsed} seconds`);
  console.log("========================================");
}

main()
  .catch((error) => {
    console.error("\n========================================");
    console.error("       ✗ SEED FAILED");
    console.error("========================================");
    console.error(error);

    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    console.log("\nDatabase connection closed.");
  });
