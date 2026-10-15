export const ENCODINGS = [
    {
        "instructionId": "mov_dup_z_r",
        "encodingId": "mov_z_r__dup_z_r_",
        "mnemonic": "DUP",
        "className": "SVE",
        "fileName": "mov_dup_z_r.xml",
        "mask": 4282383360,
        "value": 85997568,
        "bitCount": 20,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rn",
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
        "canonicalEncodingId": "dup_z_r_",
        "canonicalFileName": "dup_z_r.xml",
        "operandFamilyId": "sve-dup-scalar"
    }
];
