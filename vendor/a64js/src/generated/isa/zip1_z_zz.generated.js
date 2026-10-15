export const ENCODINGS = [
    {
        "instructionId": "zip1_z_zz",
        "encodingId": "zip1_z_zz_q",
        "mnemonic": "ZIP1",
        "className": "Low halves (quadwords)",
        "fileName": "zip1_z_zz.xml",
        "mask": 4292934656,
        "value": 94371840,
        "bitCount": 17,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opc",
                "lsb": 11,
                "width": 2
            },
            {
                "name": "H",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_F64MM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_F64MM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-permutation"
    },
    {
        "instructionId": "zip1_z_zz",
        "encodingId": "zip2_z_zz_q",
        "mnemonic": "ZIP2",
        "className": "High halves (quadwords)",
        "fileName": "zip1_z_zz.xml",
        "mask": 4292934656,
        "value": 94372864,
        "bitCount": 17,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opc",
                "lsb": 11,
                "width": 2
            },
            {
                "name": "H",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_F64MM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_F64MM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-permutation"
    },
    {
        "instructionId": "zip1_z_zz",
        "encodingId": "zip1_z_zz_",
        "mnemonic": "ZIP1",
        "className": "Low halves",
        "fileName": "zip1_z_zz.xml",
        "mask": 4280351744,
        "value": 86007808,
        "bitCount": 15,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "H",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-permutation"
    },
    {
        "instructionId": "zip1_z_zz",
        "encodingId": "zip2_z_zz_",
        "mnemonic": "ZIP2",
        "className": "High halves",
        "fileName": "zip1_z_zz.xml",
        "mask": 4280351744,
        "value": 86008832,
        "bitCount": 15,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "H",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-permutation"
    }
];
