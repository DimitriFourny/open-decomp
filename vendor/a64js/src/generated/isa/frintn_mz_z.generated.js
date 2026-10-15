export const ENCODINGS = [
    {
        "instructionId": "frintn_mz_z",
        "encodingId": "frintn_mz_z_4",
        "mnemonic": "FRINTN",
        "className": "Four registers",
        "fileName": "frintn_mz_z.xml",
        "mask": 4294966371,
        "value": 3250118656,
        "bitCount": 26,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-int-float-convert"
    },
    {
        "instructionId": "frintn_mz_z",
        "encodingId": "frintn_mz_z_2",
        "mnemonic": "FRINTN",
        "className": "Two registers",
        "fileName": "frintn_mz_z.xml",
        "mask": 4294966305,
        "value": 3249070080,
        "bitCount": 24,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 1,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-int-float-convert"
    }
];
