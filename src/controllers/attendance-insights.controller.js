import * as service from '../services/attendance-insights.service.js';

export const getAtRisk = async (req, res) =>
  res.json({
    data: await service.getAtRiskStudents({
      user: req.user,
      academicYearId: req.query.academicYearId,
      standardId: req.query.standardId,
      limit: req.query.limit,
      includeAll: req.query.includeAll,
    }),
  });

export const getStudent = async (req, res) =>
  res.json({
    data: await service.getStudentInsight({
      user: req.user,
      studentId: req.params.studentId,
      academicYearId: req.query.academicYearId,
    }),
  });

export const getAdmin = async (req, res) =>
  res.json({
    data: await service.getAdminInsights({
      academicYearId: req.query.academicYearId,
      date: req.query.date,
    }),
  });

export const getPercentageReport = async (req, res) =>
  res.json({
    data: await service.getAttendancePercentageReport({
      user: req.user,
      academicYearId: req.query.academicYearId,
      standardId: req.query.standardId,
      from: req.query.from,
      to: req.query.to,
      eligibility: req.query.eligibility,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }),
  });
