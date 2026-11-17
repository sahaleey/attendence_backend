// controllers/staff.controller.js
import prisma from '../lib/prisma.js';
import { loadAssignableRoles, actorInfo, userInclude } from '../services/access.service.js';
import { isPersonalRole, resolvePermissions } from '../permissions/resolve.js';
import ROLES from '../permissions/role.constants.js';
import P from '../permissions/permission.constants.js';
import { parseDateInput } from '../utils/date.js';
import { hashPassword } from '../utils/hash.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

const checkPassword = (pw) => {
  if (typeof pw !== 'string' || pw.length < 8) {
    throw httpError(400, 'Password must be at least 8 characters');
  }
};

// Never send the password hash (or internal per-user roles) to the browser.
const safeStaff = (staff) => {
  if (!staff?.user) return staff;
  const { passwordHash: _omit, ...user } = staff.user;
  if (user.userRoles) user.userRoles = user.userRoles.filter((ur) => !isPersonalRole(ur.role));
  return { ...staff, user };
};

// A non-admin must not edit / reset / deactivate an administrator, or anyone
// holding permissions the actor does not have (password reset = account takeover).
async function assertNotAdminTarget(actor, userId) {
  const me = actorInfo(actor);
  if (me.isAdmin) return;
  const target = await prisma.user.findUnique({ where: { id: userId }, include: userInclude });
  if (!target) return;
  if (target.userRoles.some((ur) => ur.role.name === ROLES.ADMIN)) {
    throw httpError(403, 'Only an administrator can modify an administrator account');
  }
  if (resolvePermissions(target).some((p) => !me.permissions.has(p))) {
    throw httpError(403, 'You cannot modify an account with permissions you do not have');
  }
}

const normEmail = (v) => String(v || '').trim().toLowerCase();

export const staffController = {
  // List all staff members with their user details
  list: async (req, res) => {
    const staff = await prisma.staff.findMany({
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: {
                  include: {
                    permissions: {
                      include: {
                        permission: true
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      orderBy: {
        user: {
          name: 'asc'
        }
      }
    });
    
    res.json({ data: staff.map(safeStaff) });
  },

  // Get a single staff member
  get: async (req, res) => {
    const staff = await prisma.staff.findUniqueOrThrow({
      where: { id: req.params.id },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: true
              }
            }
          }
        }
      }
    });
    
    res.json({ data: safeStaff(staff) });
  },

  // Create a staff member
  create: async (req, res) => {
    try {
      const { 
        name, 
        password, 
        roleIds, 
        employeeCode,
        designation,
        department,
        dateOfJoining
      } = req.body;
      const email = normEmail(req.body.email);
      
      // Validate required fields
      if (!name || !email || !password || !employeeCode) {
        return res.status(400).json({ 
          error: 'Name, email, password, and employee code are required' 
        });
      }
      
      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email }
      });
      
      if (existingUser) {
        return res.status(400).json({ 
          error: 'User with this email already exists' 
        });
      }

      // Check if employee code already exists
      const existingStaff = await prisma.staff.findUnique({
        where: { employeeCode }
      });

      if (existingStaff) {
        return res.status(400).json({ 
          error: 'Employee code already exists' 
        });
      }
      
      // Hash the password
      checkPassword(password);
      const passwordHash = await hashPassword(password);
      
      // Prepare user creation data
      const createData = {
        name,
        email,
        passwordHash,
        isActive: true,
        staff: {
          create: {
            employeeCode,
            designation: designation || null,
            department: department || null,
            dateOfJoining: dateOfJoining ? parseDateInput(dateOfJoining, 'dateOfJoining') : null,
            isActive: true
          }
        }
      };
      
      // Handle roleIds - if provided and is an array
      if (roleIds && Array.isArray(roleIds) && roleIds.length > 0) {
        // Validates existence and blocks privilege escalation (e.g. a
        // non-admin handing out ADMIN or permissions they do not have).
        await loadAssignableRoles(req.user, roleIds);
        
        createData.userRoles = {
          create: roleIds.map(roleId => ({
            role: {
              connect: { id: roleId }
            }
          }))
        };
      } else {
        // If no roles provided, assign a default staff role
        const defaultRole = await prisma.role.findFirst({
          where: {
            name: 'STAFF'
          }
        });
        
        if (defaultRole) {
          createData.userRoles = {
            create: [{
              role: {
                connect: { id: defaultRole.id }
              }
            }]
          };
        } else {
          return res.status(400).json({ 
            error: 'No roles provided and default STAFF role not found. Please create a STAFF role first.' 
          });
        }
      }
      
      const user = await prisma.user.create({
        data: createData,
        include: {
          staff: true,
          userRoles: {
            include: {
              role: true
            }
          }
        }
      });
      
      // Remove password hash from response
      const { passwordHash: _, ...userWithoutPassword } = user;
      
      res.status(201).json({ data: userWithoutPassword });
      
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
      console.error('Error creating staff:', error);
      res.status(500).json({ error: 'Failed to create staff member' });
    }
  },

  // Update a staff member
  update: async (req, res) => {
    try {
      const { 
        name, 
        password, 
        roleIds,
        employeeCode,
        designation,
        department,
        dateOfJoining,
        isActive
      } = req.body;
      const email = req.body.email !== undefined ? normEmail(req.body.email) : undefined;
      
      // First check if staff exists
      const existingStaff = await prisma.staff.findUnique({
        where: { id: req.params.id },
        include: { user: true }
      });
      
      if (!existingStaff) {
        return res.status(404).json({ error: 'Staff member not found' });
      }
      await assertNotAdminTarget(req.user, existingStaff.userId);

      // Activation state is governed by STAFF_DEACTIVATE, not by plain profile edits.
      if (isActive !== undefined && typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive must be true or false' });
      }
      if (isActive !== undefined && isActive !== existingStaff.isActive) {
        if (!actorInfo(req.user).permissions.has(P.STAFF_DEACTIVATE)) {
          return res.status(403).json({ error: 'You do not have permission to activate or deactivate staff' });
        }
        if (existingStaff.userId === req.user.id) {
          return res.status(400).json({ error: 'You cannot change the status of your own account' });
        }
      }
      
      // Check if email is being changed and is already taken
      if (email && email !== existingStaff.user.email) {
        const existingUser = await prisma.user.findUnique({
          where: { email }
        });
        
        if (existingUser) {
          return res.status(400).json({ 
            error: 'Email already taken by another user' 
          });
        }
      }

      // Check if employee code is being changed and is already taken
      if (employeeCode && employeeCode !== existingStaff.employeeCode) {
        const existingEmployee = await prisma.staff.findUnique({
          where: { employeeCode }
        });

        if (existingEmployee) {
          return res.status(400).json({ 
            error: 'Employee code already exists' 
          });
        }
      }
      
      // Prepare update data for user
      const userUpdateData = {
        name: name || existingStaff.user.name,
        email: email || existingStaff.user.email,
        isActive: isActive !== undefined ? isActive : existingStaff.user.isActive
      };
      
      // Update password if provided
      if (password) {
        checkPassword(password);
        userUpdateData.passwordHash = await hashPassword(password);
      }
      
      // Handle role updates if provided
      let replaceRoleIds = null;
      if (roleIds && Array.isArray(roleIds)) {
        if (existingStaff.userId === req.user.id) {
          return res.status(403).json({ error: 'You cannot change your own roles' });
        }
        await loadAssignableRoles(req.user, roleIds);
        
        replaceRoleIds = roleIds;
      }
      
      // Update user
      await prisma.user.update({
        where: { id: existingStaff.userId },
        data: userUpdateData
      });

      // A password reset or deactivation must end existing sessions.
      if (userUpdateData.passwordHash || userUpdateData.isActive === false) {
        await prisma.refreshToken.updateMany({
          where: { userId: existingStaff.userId, revokedAt: null },
          data: { revokedAt: new Date() }
        });
      }

      if (replaceRoleIds) {
        // Replace shared roles; keep the user's custom-permission role (user:<id>).
        await prisma.$transaction([
          prisma.userRole.deleteMany({
            where: {
              userId: existingStaff.userId,
              role: { name: { not: { startsWith: 'user:' } } }
            }
          }),
          prisma.userRole.createMany({
            data: replaceRoleIds.map((roleId) => ({ userId: existingStaff.userId, roleId })),
            skipDuplicates: true
          })
        ]);
      }

      // Update staff
      const updatedStaff = await prisma.staff.update({
        where: { id: req.params.id },
        data: {
          employeeCode: employeeCode || existingStaff.employeeCode,
          designation: designation !== undefined ? designation : existingStaff.designation,
          department: department !== undefined ? department : existingStaff.department,
          dateOfJoining: dateOfJoining ? parseDateInput(dateOfJoining, 'dateOfJoining') : existingStaff.dateOfJoining,
          isActive: isActive !== undefined ? isActive : existingStaff.isActive
        },
        include: {
          user: {
            include: {
              userRoles: {
                include: {
                  role: true
                }
              }
            }
          }
        }
      });
      
      // Remove password hash from response
      const { passwordHash: _, ...staffWithoutPassword } = updatedStaff.user;
      const response = { ...updatedStaff, user: staffWithoutPassword };
      
      res.json({ data: response });
      
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
      console.error('Error updating staff:', error);
      res.status(500).json({ error: 'Failed to update staff member' });
    }
  },

  // Remove/Deactivate a staff member
  remove: async (req, res) => {
    try {
      // Check if staff exists
      const existingStaff = await prisma.staff.findUnique({
        where: { id: req.params.id },
        include: { user: true }
      });
      
      if (!existingStaff) {
        return res.status(404).json({ error: 'Staff member not found' });
      }
      await assertNotAdminTarget(req.user, existingStaff.userId);
      if (existingStaff.userId === req.user.id) {
        return res.status(400).json({ error: 'You cannot deactivate your own account' });
      }
      
      // Soft delete (deactivate both staff and user)
      await prisma.$transaction([
        prisma.staff.update({
          where: { id: req.params.id },
          data: { isActive: false }
        }),
        prisma.user.update({
          where: { id: existingStaff.userId },
          data: { isActive: false }
        }),
        prisma.refreshToken.updateMany({
          where: { userId: existingStaff.userId, revokedAt: null },
          data: { revokedAt: new Date() }
        })
      ]);

      // Get updated staff
      const updatedStaff = await prisma.staff.findUnique({
        where: { id: req.params.id },
        include: {
          user: {
            include: {
              userRoles: {
                include: {
                  role: true
                }
              }
            }
          }
        }
      });

      // Remove password hash from response
      const { passwordHash: _, ...staffWithoutPassword } = updatedStaff.user;
      const response = { ...updatedStaff, user: staffWithoutPassword };
      
      res.json({ data: response });
      
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error('Error removing staff:', error);
      res.status(500).json({ error: 'Failed to remove staff member' });
    }
  },

  // Get staff by user ID
  getByUserId: async (req, res) => {
    try {
      const staff = await prisma.staff.findUnique({
        where: { userId: req.params.userId },
        include: {
          user: {
            include: {
              userRoles: {
                include: {
                  role: true
                }
              }
            }
          }
        }
      });
      
      if (!staff) {
        return res.status(404).json({ error: 'Staff member not found' });
      }
      
      res.json({ data: safeStaff(staff) });
    } catch (error) {
      console.error('Error fetching staff by user ID:', error);
      res.status(500).json({ error: 'Failed to fetch staff member' });
    }
  }
};